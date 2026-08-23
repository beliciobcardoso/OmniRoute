/**
 * db/usageAnalytics.ts — Read-only aggregation queries over `usage_history`
 * and `daily_usage_summary` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/usage/analytics and /api/settings/export-json routes can delegate.
 * Read-only aggregation; no writes.
 *
 * Sliced out of #3500 (usage_history / daily_usage_summary cluster).
 */

import { getDbInstance } from "./core";
import type { AnalyticsParams } from "./usageAnalytics/sources";
import { CompiledQuery } from "kysely";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// These queries are hand-written SQL strings executed via better-sqlite3's
// named-parameter binding (`@name`). Postgres has no named-parameter syntax —
// only positional `$1, $2, ...` — so this rewrites `@name` tokens into
// positional placeholders (reusing the same `$N` for repeated names) and
// returns a values array in matching order. It also swaps the two SQLite-only
// expressions this module actually uses: `DATE(timestamp)` (timestamp is
// stored as an ISO-8601 TEXT column, so `::date` is the direct Postgres
// equivalent) and `strftime('%w', timestamp)` (ISO day-of-week, replicated via
// EXTRACT(DOW ...) cast back to text so callers see the same "0".."6" shape).
// Every other expression in this file (LOWER, COALESCE, NULLIF, CASE WHEN,
// COUNT/SUM/AVG, JOIN) is already portable ANSI SQL, so no other rewriting is
// needed — the query text is otherwise byte-identical across both dialects.
//
// One more dialect quirk: every result column here is aliased camelCase
// (`as totalRequests`), and several queries also reference that alias again
// in GROUP BY / ORDER BY (and, for getWeeklyPatternRows, an outer SELECT
// over an inner subquery) — all unquoted. SQLite preserves identifiers
// verbatim; Postgres folds unquoted identifiers to lowercase, so an alias
// defined as `"totalRequests"` (once quoted) would no longer match a bare
// `totalRequests` reference elsewhere in the same query ("column
// totalrequests does not exist"). So: collect every camelCase alias
// introduced via `as <alias>`, then quote *every* occurrence of that exact
// word throughout the text — the definition and every later reference alike.
export function toPostgresAnalyticsSql(
  sqlText: string,
  params: Record<string, unknown>
): { text: string; values: unknown[] } {
  let text = sqlText
    .replace(/DATE\(timestamp\)/g, "(timestamp)::date")
    .replace(/strftime\('%w',\s*timestamp\)/g, "EXTRACT(DOW FROM (timestamp)::timestamptz)::text");

  const camelAliases = new Set<string>();
  for (const m of text.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (/[A-Z]/.test(m[1])) camelAliases.add(m[1]);
  }
  for (const alias of camelAliases) {
    text = text.replace(new RegExp(`\\b${alias}\\b`, "g"), `"${alias}"`);
  }

  const values: unknown[] = [];
  const seen = new Map<string, number>();
  text = text.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
    if (seen.has(name)) return `$${seen.get(name)}`;
    values.push(params[name]);
    const idx = values.length;
    seen.set(name, idx);
    return `$${idx}`;
  });
  return { text, values };
}

async function runAnalyticsQueryPg<T>(
  sqlText: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  await ensurePostgresBootstrap();
  const kdb = getKyselyDb();
  const { text, values } = toPostgresAnalyticsSql(sqlText, params);
  const result = await kdb.executeQuery(CompiledQuery.raw(text, values));
  return result.rows as T[];
}

export { buildUnifiedSource, buildPresetUnifiedSource } from "./usageAnalytics/sources";
export type {
  AnalyticsParams,
  BuildUnifiedSourceOptions,
  UnifiedSourceResult,
} from "./usageAnalytics/sources";

// ---------------------------------------------------------------------------
// Analytics summary — /api/usage/analytics
// ---------------------------------------------------------------------------

export interface UsageSummaryRow {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  uniqueModels: number;
  uniqueAccounts: number;
  uniqueApiKeys: number;
  successfulRequests: number;
  avgLatencyMs: number;
  firstRequest: string;
  lastRequest: string;
}

/**
 * Scalar summary over the unified source CTE.
 *
 * @param unifiedSource - Pre-built subquery string (UNION of raw + aggregated rows).
 * @param params        - Named params referenced inside `unifiedSource`.
 */
export async function getUsageSummary(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<UsageSummaryRow> {
  const sqlText = `
      SELECT
        COUNT(*) as totalRequests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COUNT(DISTINCT model) as uniqueModels,
        COUNT(DISTINCT connection_id) as uniqueAccounts,
        COUNT(DISTINCT COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''))) as uniqueApiKeys,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(MIN(timestamp), '') as firstRequest,
        COALESCE(MAX(timestamp), '') as lastRequest
      FROM ${unifiedSource} AS _u
    `;
  const row = isPostgres()
    ? (await runAnalyticsQueryPg<UsageSummaryRow>(sqlText, params))[0]
    : (getDbInstance().prepare(sqlText).get(params) as UsageSummaryRow | undefined);
  return (
    row ?? {
      totalRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      uniqueModels: 0,
      uniqueAccounts: 0,
      uniqueApiKeys: 0,
      successfulRequests: 0,
      avgLatencyMs: 0,
      firstRequest: "",
      lastRequest: "",
    }
  );
}

// ---------------------------------------------------------------------------

export interface DailyUsageRow {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Daily request + token counts aggregated from the unified source CTE.
 */
export async function getDailyUsage(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<DailyUsageRow[]> {
  const sqlText = `
      SELECT
        DATE(timestamp) as date,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<DailyUsageRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as DailyUsageRow[];
}

// ---------------------------------------------------------------------------

export interface DailyCostRow {
  date: string;
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-day, per-provider, per-model token breakdown for cost calculation.
 */
export async function getDailyCostRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<DailyCostRow[]> {
  const sqlText = `
      SELECT
        DATE(timestamp) as date,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp), LOWER(provider), LOWER(model), serviceTier
      ORDER BY date ASC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<DailyCostRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as DailyCostRow[];
}

// ---------------------------------------------------------------------------

export interface HeatmapRow {
  date: string;
  totalTokens: number;
}

/**
 * Per-day token totals for the activity heatmap.
 * Uses `usage_history` directly (not the unified CTE) since the heatmap has its
 * own independent time window and api_key filter.
 *
 * @param heatmapConditions - Array of SQL condition strings (combined with AND).
 * @param params            - Named params referenced inside the conditions.
 */
export async function getHeatmapRows(
  heatmapConditions: string[],
  params: AnalyticsParams
): Promise<HeatmapRow[]> {
  const sqlText = `
      SELECT
        DATE(timestamp) as date,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM usage_history
      WHERE ${heatmapConditions.join(" AND ")}
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<HeatmapRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as HeatmapRow[];
}

// ---------------------------------------------------------------------------

export interface ModelUsageRow {
  model: string;
  provider: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
}

/**
 * Per-model usage aggregates from the unified source CTE.
 */
export async function getModelUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ModelUsageRow[]> {
  const sqlText = `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
        COALESCE(MAX(timestamp), '') as lastUsed
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(model), LOWER(provider), serviceTier
      ORDER BY requests DESC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<ModelUsageRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as ModelUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ProviderCostRow {
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-provider, per-model token breakdown for provider cost calculation.
 */
export async function getProviderCostRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderCostRow[]> {
  const sqlText = `
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(provider), LOWER(model), serviceTier
    `;
  if (isPostgres()) return runAnalyticsQueryPg<ProviderCostRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as ProviderCostRow[];
}

// ---------------------------------------------------------------------------

export interface ProviderUsageRow {
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
}

/**
 * Per-provider usage aggregates from the unified source CTE.
 */
export async function getProviderUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderUsageRow[]> {
  const sqlText = `
      SELECT
        LOWER(provider) as provider,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(provider)
      ORDER BY requests DESC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<ProviderUsageRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as ProviderUsageRow[];
}

// ---------------------------------------------------------------------------

export interface AccountCostRow {
  account: string;
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-account cost breakdown joined with provider_connections for display names.
 * Uses `usage_history` directly (JOIN requires real table, not a subquery alias).
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export async function getAccountCostRows(
  whereClause: string,
  params: AnalyticsParams
): Promise<AccountCostRow[]> {
  const sqlText = `
      SELECT
        COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), NULLIF(c.name, ''), usage_history.connection_id, 'unknown') as account,
        LOWER(usage_history.provider) as provider,
        LOWER(usage_history.model) as model,
        COALESCE(NULLIF(usage_history.service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(usage_history.tokens_input), 0) as promptTokens,
        COALESCE(SUM(usage_history.tokens_output), 0) as completionTokens,
        COALESCE(SUM(usage_history.tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(usage_history.tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(usage_history.tokens_reasoning), 0) as reasoningTokens
      FROM usage_history
      LEFT JOIN provider_connections c ON c.id = usage_history.connection_id
      ${whereClause}
      GROUP BY account, LOWER(usage_history.provider), LOWER(usage_history.model), serviceTier
    `;
  if (isPostgres()) return runAnalyticsQueryPg<AccountCostRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as AccountCostRow[];
}

// ---------------------------------------------------------------------------

export interface AccountUsageRow {
  account: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  lastUsed: string;
}

/**
 * Per-account usage aggregates joined with provider_connections for display names.
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export async function getAccountUsageRows(
  whereClause: string,
  params: AnalyticsParams
): Promise<AccountUsageRow[]> {
  const sqlText = `
      SELECT
        COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), NULLIF(c.name, ''), usage_history.connection_id, 'unknown') as account,
        COUNT(usage_history.id) as requests,
        COALESCE(SUM(usage_history.tokens_input), 0) as promptTokens,
        COALESCE(SUM(usage_history.tokens_output), 0) as completionTokens,
        COALESCE(SUM(usage_history.tokens_input + usage_history.tokens_output), 0) as totalTokens,
        COALESCE(AVG(usage_history.latency_ms), 0) as avgLatencyMs,
        COALESCE(MAX(usage_history.timestamp), '') as lastUsed
      FROM usage_history
      LEFT JOIN provider_connections c ON c.id = usage_history.connection_id
      ${whereClause}
      GROUP BY account
      ORDER BY requests DESC
      LIMIT 50
    `;
  if (isPostgres()) return runAnalyticsQueryPg<AccountUsageRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as AccountUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ApiKeyUsageRow {
  apiKeyId: string | null;
  apiKeyGroupKey: string;
  provider: string;
  model: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/**
 * Per-API-key usage aggregates from usage_history.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export async function getApiKeyUsageRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): Promise<ApiKeyUsageRow[]> {
  const sqlText = `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown'), NULLIF(api_key_id, ''), LOWER(provider), LOWER(model), serviceTier
    `;
  if (isPostgres()) return runAnalyticsQueryPg<ApiKeyUsageRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as ApiKeyUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ServiceTierUsageRow {
  serviceTier: string;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/**
 * Per-service-tier, per-provider, per-model usage aggregates.
 */
export async function getServiceTierUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ServiceTierUsageRow[]> {
  const sqlText = `
      SELECT
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM ${unifiedSource} AS _u
      GROUP BY serviceTier, LOWER(provider), LOWER(model)
    `;
  if (isPostgres()) return runAnalyticsQueryPg<ServiceTierUsageRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as ServiceTierUsageRow[];
}

// ---------------------------------------------------------------------------

export interface ApiKeyMetadataRow {
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyGroupKey: string;
  lastUsed: string;
}

/**
 * Latest API key name + group key from usage_history for display metadata.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export async function getApiKeyMetadataRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): Promise<ApiKeyMetadataRow[]> {
  const sqlText = `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        NULLIF(api_key_name, '') as apiKeyName,
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
        MAX(timestamp) as lastUsed
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY NULLIF(api_key_id, ''), NULLIF(api_key_name, '')
      ORDER BY lastUsed DESC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<ApiKeyMetadataRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as ApiKeyMetadataRow[];
}

// ---------------------------------------------------------------------------

export interface WeeklyPatternRow {
  dayOfWeek: string;
  days: number;
  requests: number;
  totalTokens: number;
}

/**
 * Day-of-week aggregates for the weekly activity pattern chart.
 */
export async function getWeeklyPatternRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<WeeklyPatternRow[]> {
  const sqlText = `
      SELECT
        dayOfWeek,
        COUNT(*) as days,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(totalTokens), 0) as totalTokens
      FROM (
        SELECT
          DATE(timestamp) as date,
          strftime('%w', timestamp) as dayOfWeek,
          COUNT(*) as requests,
          COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
        FROM ${unifiedSource} AS _u
        GROUP BY DATE(timestamp), strftime('%w', timestamp)
      )
      GROUP BY dayOfWeek
      ORDER BY dayOfWeek ASC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<WeeklyPatternRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as WeeklyPatternRow[];
}

// ---------------------------------------------------------------------------

export interface PresetCostModelRow {
  model: string;
  provider: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-model token breakdown for preset range cost calculation.
 * Uses a preset-specific unified source (may differ from the main query window).
 */
export async function getPresetCostModelRows(
  presetUnifiedSource: string,
  params: AnalyticsParams
): Promise<PresetCostModelRow[]> {
  const sqlText = `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM ${presetUnifiedSource} AS _pu
      GROUP BY LOWER(model), LOWER(provider), serviceTier
    `;
  if (isPostgres()) return runAnalyticsQueryPg<PresetCostModelRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as PresetCostModelRow[];
}

// ---------------------------------------------------------------------------
// Endpoint dimension — ported from decolua/9router#152 (thanks @toanalien).
// Reads directly from usage_history (raw rows) so the unified CTE stays
// untouched; matches the pattern used by getAutoRoutingVariantBreakdown.
// ---------------------------------------------------------------------------

export interface EndpointUsageRow {
  endpoint: string;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
}

export interface EndpointUsageParams {
  sinceIso?: string | null;
  untilIso?: string | null;
}

/**
 * Per-endpoint × provider × model usage aggregates from `usage_history`.
 * NULL endpoints fold into the 'unknown' bucket so legacy rows stay visible.
 *
 * Inspired by decolua/9router#152 (byEndpoint aggregation), reshaped for the
 * OmniRoute SQLite schema + analytics conventions.
 */
export async function getEndpointUsageRows(
  params: EndpointUsageParams = {}
): Promise<EndpointUsageRow[]> {
  const conditions: string[] = [];
  const bind: Record<string, unknown> = {};
  if (params.sinceIso) {
    conditions.push("timestamp >= @since");
    bind.since = params.sinceIso;
  }
  if (params.untilIso) {
    conditions.push("timestamp <= @until");
    bind.until = params.untilIso;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sqlText = `
      SELECT
        COALESCE(NULLIF(endpoint, ''), 'unknown') as endpoint,
        LOWER(COALESCE(provider, 'unknown')) as provider,
        LOWER(COALESCE(model, 'unknown')) as model,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
        COALESCE(MAX(timestamp), '') as lastUsed
      FROM usage_history
      ${whereSql}
      GROUP BY endpoint, LOWER(COALESCE(provider, 'unknown')), LOWER(COALESCE(model, 'unknown'))
      ORDER BY requests DESC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<EndpointUsageRow>(sqlText, bind);
  return getDbInstance().prepare(sqlText).all(bind) as EndpointUsageRow[];
}

// ---------------------------------------------------------------------------
// Request count per provider, per date — #4009
// ---------------------------------------------------------------------------

export interface ProviderDailyUsageRow {
  date: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Per-day, per-provider request counts + token totals from the unified source CTE.
 * Answers "how many requests did provider X get on date Y" (#4009) — providers that
 * bill per-request rather than per-token need this breakdown, not just the
 * per-provider aggregate (`getProviderUsageRows`) or the per-day aggregate
 * (`getDailyUsage`).
 */
export async function getProviderDailyUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderDailyUsageRow[]> {
  const sqlText = `
      SELECT
        DATE(timestamp) as date,
        LOWER(provider) as provider,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp), LOWER(provider)
      ORDER BY date DESC, requests DESC
    `;
  if (isPostgres()) return runAnalyticsQueryPg<ProviderDailyUsageRow>(sqlText, params);
  return getDbInstance().prepare(sqlText).all(params) as ProviderDailyUsageRow[];
}

// ---------------------------------------------------------------------------
// Export-JSON backup — /api/settings/export-json
// ---------------------------------------------------------------------------

/**
 * Returns all rows from `usage_history` for backup export.
 * Only called when `?includeHistory=true` is explicitly requested.
 */
export async function getAllUsageHistory(): Promise<Record<string, unknown>[]> {
  if (isPostgres()) return runAnalyticsQueryPg("SELECT * FROM usage_history", {});
  return getDbInstance().prepare("SELECT * FROM usage_history").all() as Record<string, unknown>[];
}

/**
 * Returns all rows from `domain_cost_history` for backup export.
 */
export async function getAllDomainCostHistory(): Promise<Record<string, unknown>[]> {
  if (isPostgres()) return runAnalyticsQueryPg("SELECT * FROM domain_cost_history", {});
  return getDbInstance().prepare("SELECT * FROM domain_cost_history").all() as Record<
    string,
    unknown
  >[];
}

/**
 * Returns all rows from `domain_budgets` for backup export.
 */
export async function getAllDomainBudgets(): Promise<Record<string, unknown>[]> {
  if (isPostgres()) return runAnalyticsQueryPg("SELECT * FROM domain_budgets", {});
  return getDbInstance().prepare("SELECT * FROM domain_budgets").all() as Record<string, unknown>[];
}
