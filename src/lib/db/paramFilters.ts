/**
 * db/paramFilters.ts — Provider/Model parameter filter configuration.
 *
 * CRUD against the key_value table under namespace "provider_param_filters".
 * Follows the established key_value pattern from databaseSettings.ts.
 *
 * Read access (getParamFilterConfig/isAutoLearnGloballyEnabled) is on the hot
 * dispatch path (open-sse/executors/base.ts, translator/paramSupport.ts) and
 * must stay synchronous — it reads from an in-memory cache that is warmed
 * asynchronously at startup (see ensureParamFilterCacheLoaded, called from
 * src/instrumentation-node.ts) and refreshed after every write.
 */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

const NAMESPACE = "provider_param_filters";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ModelParamFilter {
  block?: string[];
  allow?: string[];
}

export interface ProviderParamFilter {
  /** Provider-level params to strip from all requests to this provider. */
  block: string[];
  /** Provider-level params to re-add after denylist stripping. */
  allow: string[];
  /** Model-specific overrides (stricter than provider-level). */
  models?: Record<string, ModelParamFilter>;
  /** When true, upstream 400 "Unsupported parameter" errors auto-populate block. */
  autoLearn?: boolean;
}

// ── Cache ───────────────────────────────────────────────────────────────────

let filterCache: Map<string, ProviderParamFilter> | null = null;
let cacheGeneration = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStoredValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toNormalizedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : [];
}

function toModelParamFilter(raw: Record<string, unknown>): ModelParamFilter | null {
  const block = toStringArray(raw.block);
  const allow = toStringArray(raw.allow);
  if (block.length === 0 && allow.length === 0) return null;
  const filter: ModelParamFilter = {};
  if (block.length > 0) filter.block = block;
  if (allow.length > 0) filter.allow = allow;
  return filter;
}

function toModelParamFilters(raw: unknown): Record<string, ModelParamFilter> {
  const models: Record<string, ModelParamFilter> = {};
  if (!isRecord(raw)) return models;
  for (const [modelId, val] of Object.entries(raw)) {
    if (!isRecord(val)) continue;
    const filter = toModelParamFilter(val);
    if (filter) models[modelId] = filter;
  }
  return models;
}

function toProviderParamFilter(raw: unknown): ProviderParamFilter | null {
  if (!isRecord(raw)) return null;
  const block = toStringArray(raw.block);
  const allow = toStringArray(raw.allow);
  const models = toModelParamFilters(raw.models);
  const autoLearn = typeof raw.autoLearn === "boolean" ? raw.autoLearn : false;
  return { block, allow, models: Object.keys(models).length > 0 ? models : undefined, autoLearn };
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

async function loadAllConfigs(): Promise<Map<string, ProviderParamFilter>> {
  const raw = await readNamespace(NAMESPACE);
  const map = new Map<string, ProviderParamFilter>();
  for (const [key, value] of Object.entries(raw)) {
    const parsed = toProviderParamFilter(value);
    if (parsed) {
      map.set(key, parsed);
    }
  }
  return map;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Warm (or re-warm) the in-memory cache from the DB. Call once at startup
 * (src/instrumentation-node.ts) before serving traffic, and after every write
 * in this module so the hot-path sync readers below see fresh data.
 */
export async function ensureParamFilterCacheLoaded(): Promise<Map<string, ProviderParamFilter>> {
  filterCache = await loadAllConfigs();
  return filterCache;
}

/**
 * Synchronous hot-path read. Returns the cached map, which is empty (not
 * null) once ensureParamFilterCacheLoaded() has resolved at least once; a
 * lookup before startup warm-up completes returns an empty map (same
 * behavior as "no filters configured yet").
 */
function loadParamFilterConfigsSync(): Map<string, ProviderParamFilter> {
  return filterCache ?? new Map();
}

/**
 * Get the param filter config for a single provider, or null if not configured.
 * Reads the in-memory cache — see module doc for why this stays synchronous.
 */
export function getParamFilterConfig(provider: string): ProviderParamFilter | null {
  return toNormalizedString(provider) ? (loadParamFilterConfigsSync().get(provider) ?? null) : null;
}

/**
 * Upsert the entire param filter config for a provider.
 * Refreshes the in-memory cache before returning.
 */
export async function setParamFilterConfig(
  provider: string,
  config: ProviderParamFilter
): Promise<void> {
  if (!toNormalizedString(provider)) return;

  // Normalize the filter before persisting
  const normalized: ProviderParamFilter = {
    block: config.block ?? [],
    allow: config.allow ?? [],
    autoLearn: config.autoLearn ?? false,
    models: config.models && Object.keys(config.models).length > 0 ? config.models : undefined,
  };
  const value = JSON.stringify(normalized);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: NAMESPACE, key: provider, value })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value }))
      .execute();
  } else {
    getDbInstance()
      .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
      .run(NAMESPACE, provider, value);
  }

  cacheGeneration++;
  await ensureParamFilterCacheLoaded();
}

/**
 * Delete the param filter config for a provider.
 * Resets to no filtering for that provider.
 */
export async function deleteParamFilterConfig(provider: string): Promise<void> {
  if (!toNormalizedString(provider)) return;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("key_value")
      .where("namespace", "=", NAMESPACE)
      .where("key", "=", provider)
      .execute();
  } else {
    getDbInstance()
      .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
      .run(NAMESPACE, provider);
  }

  cacheGeneration++;
  await ensureParamFilterCacheLoaded();
}

// ── Global auto-learn flag ──────────────────────────────────────────────────

const GLOBAL_AUTOLEARN_KEY = "__global__";

/**
 * Check whether the global auto-learn flag is enabled.
 * When enabled, ALL providers auto-learn unsupported params from 400 errors
 * regardless of their per-provider autoLearn setting.
 * Only fires when this is explicitly configured, else returns false.
 */
export function isAutoLearnGloballyEnabled(): boolean {
  const globalCfg = getParamFilterConfig(GLOBAL_AUTOLEARN_KEY);
  return globalCfg?.autoLearn === true;
}

/**
 * Enable or disable global auto-learn globally for all providers.
 * When enabled, the per-provider autoLearn flag is still honored after
 * the global check (either being on is sufficient to trigger auto-learn).
 */
export async function setGlobalAutoLearnEnabled(enabled: boolean): Promise<void> {
  const existing = getParamFilterConfig(GLOBAL_AUTOLEARN_KEY);
  await setParamFilterConfig(GLOBAL_AUTOLEARN_KEY, {
    block: existing?.block ?? [],
    allow: existing?.allow ?? [],
    autoLearn: enabled,
  });
}

/**
 * Auto-learn helper: add a single parameter to a provider's block list.
 * If the field is already in the block list (or the config does not exist),
 * this is a no-op. Optionally scoped to a specific model.
 */
export async function addParamToBlocklist(
  provider: string,
  paramName: string,
  model?: string
): Promise<void> {
  if (!toNormalizedString(provider) || !toNormalizedString(paramName)) return;

  const existing = getParamFilterConfig(provider) ?? {
    block: [],
    allow: [],
    autoLearn: false,
  };

  if (model) {
    // Model-level
    const models = existing.models ?? {};
    const modelCfg = models[model] ?? {};

    if (Array.isArray(modelCfg.block) && modelCfg.block.includes(paramName)) return;

    const updatedBlock = [...(modelCfg.block ?? []), paramName];
    models[model] = { ...modelCfg, block: updatedBlock };
    existing.models = models;
  } else {
    // Provider-level
    if (existing.block.includes(paramName)) return;
    existing.block = [...existing.block, paramName];
  }

  await setParamFilterConfig(provider, existing);
}
