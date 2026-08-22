/**
 * db/interceptionRules.ts — Per-model web-search / web-fetch interception rules (#3384).
 *
 * CRUD against the key_value table under namespace "interception_rules". Follows the
 * established key_value pattern from paramFilters.ts / databaseSettings.ts.
 *
 * Resolution precedence (see resolveInterceptSearch): per-model rule > provider-level
 * rule > undefined (caller falls back to the existing native-bypass defaults).
 *
 * getInterceptionRules/resolveInterceptSearch are on the hot request path
 * (called per chat request to decide native-bypass vs. interception) and must
 * stay synchronous — see paramFilters.ts for the identical cache-preserving
 * pattern this module follows. The cache is warmed asynchronously at startup
 * (ensureInterceptionRulesCacheLoaded, called from src/instrumentation-node.ts)
 * and refreshed after every write.
 */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

const NAMESPACE = "interception_rules";

// ── Types ───────────────────────────────────────────────────────────────────

export type FetchInterceptionBackend = "firecrawl" | "jina" | "tavily";

export interface ModelInterceptionRule {
  /** true = route through OmniRoute's /v1/search; false = force native passthrough. */
  interceptSearch?: boolean;
  /** true = route through OmniRoute's /v1/web/fetch; false = force native passthrough. */
  interceptFetch?: boolean;
  fetchBackend?: FetchInterceptionBackend;
  fetchProxyUrl?: string;
}

export interface ProviderInterceptionRules {
  /** Provider-level default, used when a model has no override. */
  interceptSearch?: boolean;
  interceptFetch?: boolean;
  fetchBackend?: FetchInterceptionBackend;
  fetchProxyUrl?: string;
  /** Per-model overrides (stricter/looser than provider-level). */
  models?: Record<string, ModelInterceptionRule>;
}

// ── Cache ───────────────────────────────────────────────────────────────────

let rulesCache: Map<string, ProviderInterceptionRules> | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNormalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toOptionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toFetchBackend(value: unknown): FetchInterceptionBackend | undefined {
  return value === "firecrawl" || value === "jina" || value === "tavily" ? value : undefined;
}

function parseStoredValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toModelInterceptionRule(raw: unknown): ModelInterceptionRule | null {
  if (!isRecord(raw)) return null;
  const rule: ModelInterceptionRule = {
    interceptSearch: toOptionalBool(raw.interceptSearch),
    interceptFetch: toOptionalBool(raw.interceptFetch),
    fetchBackend: toFetchBackend(raw.fetchBackend),
    fetchProxyUrl: toNormalizedString(raw.fetchProxyUrl) ?? undefined,
  };
  const hasAnyField = Object.values(rule).some((v) => v !== undefined);
  return hasAnyField ? rule : null;
}

function toModelInterceptionRules(raw: unknown): Record<string, ModelInterceptionRule> {
  const models: Record<string, ModelInterceptionRule> = {};
  if (!isRecord(raw)) return models;
  for (const [modelId, val] of Object.entries(raw)) {
    const rule = toModelInterceptionRule(val);
    if (rule) models[modelId] = rule;
  }
  return models;
}

function toProviderInterceptionRules(raw: unknown): ProviderInterceptionRules | null {
  if (!isRecord(raw)) return null;
  const models = toModelInterceptionRules(raw.models);
  return {
    interceptSearch: toOptionalBool(raw.interceptSearch),
    interceptFetch: toOptionalBool(raw.interceptFetch),
    fetchBackend: toFetchBackend(raw.fetchBackend),
    fetchProxyUrl: toNormalizedString(raw.fetchProxyUrl) ?? undefined,
    models: Object.keys(models).length > 0 ? models : undefined,
  };
}

// ── Read ────────────────────────────────────────────────────────────────────

async function readNamespace(namespace: string): Promise<Record<string, unknown>> {
  let rows: Array<{ key: string; value: string }>;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    rows = (await getKyselyDb()
      .selectFrom("key_value")
      .select(["key", "value"])
      .where("namespace", "=", namespace)
      .execute()) as Array<{ key: string; value: string }>;
  } else {
    rows = getDbInstance()
      .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
      .all(namespace) as Array<{ key: string; value: string }>;
  }

  const values: Record<string, unknown> = {};
  for (const row of rows) {
    values[row.key] = parseStoredValue(row.value);
  }
  return values;
}

async function loadAllRules(): Promise<Map<string, ProviderInterceptionRules>> {
  const raw = await readNamespace(NAMESPACE);
  const map = new Map<string, ProviderInterceptionRules>();
  for (const [key, value] of Object.entries(raw)) {
    const parsed = toProviderInterceptionRules(value);
    if (parsed) map.set(key, parsed);
  }
  return map;
}

/**
 * Warm (or re-warm) the in-memory cache from the DB. Call once at startup
 * (src/instrumentation-node.ts) before serving traffic, and after every write
 * in this module so the hot-path sync readers below see fresh data.
 */
export async function ensureInterceptionRulesCacheLoaded(): Promise<
  Map<string, ProviderInterceptionRules>
> {
  rulesCache = await loadAllRules();
  return rulesCache;
}

function loadRulesCachedSync(): Map<string, ProviderInterceptionRules> {
  return rulesCache ?? new Map();
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Get the interception rules for a single provider, or null if not configured. */
export function getInterceptionRules(provider: string): ProviderInterceptionRules | null {
  return toNormalizedString(provider) ? (loadRulesCachedSync().get(provider) ?? null) : null;
}

/** Upsert the entire interception rule set for a provider. Refreshes the cache. */
export async function setInterceptionRules(
  provider: string,
  rules: ProviderInterceptionRules
): Promise<void> {
  const normalizedProvider = toNormalizedString(provider);
  if (!normalizedProvider) return;

  const normalized: ProviderInterceptionRules = {
    interceptSearch: rules.interceptSearch,
    interceptFetch: rules.interceptFetch,
    fetchBackend: rules.fetchBackend,
    fetchProxyUrl: rules.fetchProxyUrl,
    models: rules.models && Object.keys(rules.models).length > 0 ? rules.models : undefined,
  };
  const value = JSON.stringify(normalized);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: NAMESPACE, key: normalizedProvider, value })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value }))
      .execute();
  } else {
    getDbInstance()
      .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
      .run(NAMESPACE, normalizedProvider, value);
  }

  await ensureInterceptionRulesCacheLoaded();
}

/** Delete the interception rules for a provider. Resets that provider to default behavior. */
export async function deleteInterceptionRules(provider: string): Promise<void> {
  const normalizedProvider = toNormalizedString(provider);
  if (!normalizedProvider) return;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("key_value")
      .where("namespace", "=", NAMESPACE)
      .where("key", "=", normalizedProvider)
      .execute();
  } else {
    getDbInstance()
      .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
      .run(NAMESPACE, normalizedProvider);
  }

  await ensureInterceptionRulesCacheLoaded();
}

/**
 * Resolve the effective `interceptSearch` override for a provider/model pair.
 *
 * Precedence: per-model rule > provider-level rule > undefined (no override — the
 * caller should fall back to the existing native-bypass defaults).
 */
export function resolveInterceptSearch(
  provider: string | null | undefined,
  model: string | null | undefined
): boolean | undefined {
  const normalizedProvider = toNormalizedString(provider);
  if (!normalizedProvider) return undefined;

  const rules = getInterceptionRules(normalizedProvider);
  if (!rules) return undefined;

  const normalizedModel = toNormalizedString(model);
  if (normalizedModel && rules.models?.[normalizedModel]?.interceptSearch !== undefined) {
    return rules.models[normalizedModel].interceptSearch;
  }

  return rules.interceptSearch;
}
