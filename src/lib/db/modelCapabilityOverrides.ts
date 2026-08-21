import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("DB_MODEL_CAPABILITY_OVERRIDES");

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

interface PgCachedOverride {
  provider: string;
  modelId: string;
  overrideKey: string;
  value: string;
  refreshedAt: string;
}

/**
 * In-memory cache of Postgres-backed model_capability_overrides rows, keyed
 * by "provider/model_id/override_key".
 *
 * getModelCapabilityOverride()/listModelCapabilityOverrides() MUST stay
 * synchronous — they're read from hot-path chat request handling
 * (modelCapabilities.ts's max_token resolution, consumed by the translator/
 * combo/vision-bridge chain) that cannot become async without a much larger
 * ripple. Overrides are rare, operator-triggered admin actions, so a short
 * staleness window plus a best-effort, fire-and-forget Postgres write on
 * set/remove is an accepted trade-off (same pattern as
 * featureFlags.ts/cliToolState.ts/databaseSettings.ts).
 */
let pgCache: Map<string, PgCachedOverride> | null = null;
let pgCacheLoadedAt = 0;
let pgCacheLoadInFlight: Promise<void> | null = null;
let pgCacheEpoch = 0;
const PG_CACHE_TTL_MS = 30_000;

function cacheKey(provider: string, modelId: string, key: string): string {
  // JSON-encoded rather than delimiter-joined — provider/modelId can contain
  // "/" themselves, which would otherwise make two distinct triples collide.
  return JSON.stringify([provider, modelId, key]);
}

function refreshPgCacheInBackground(): void {
  if (pgCacheLoadInFlight) return;
  const epochAtStart = pgCacheEpoch;
  pgCacheLoadInFlight = (async () => {
    try {
      await ensurePostgresBootstrap();
      const rows = await getKyselyDb()
        .selectFrom("model_capability_overrides")
        .select(["provider", "model_id", "override_key", "override_value", "refreshed_at"])
        .execute();
      const next = new Map<string, PgCachedOverride>();
      for (const row of rows) {
        next.set(cacheKey(row.provider, row.model_id, row.override_key), {
          provider: row.provider,
          modelId: row.model_id,
          overrideKey: row.override_key,
          value: row.override_value,
          refreshedAt: row.refreshed_at,
        });
      }
      if (pgCacheEpoch === epochAtStart) {
        pgCache = next;
        pgCacheLoadedAt = Date.now();
      }
    } catch (err) {
      log.warn("model_capability_overrides.pg_cache_refresh_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pgCacheLoadInFlight = null;
    }
  })();
}

function getPgCache(): Map<string, PgCachedOverride> {
  if (pgCache === null || Date.now() - pgCacheLoadedAt > PG_CACHE_TTL_MS) {
    refreshPgCacheInBackground();
  }
  return pgCache ?? new Map();
}

function persistPgUpsert(provider: string, modelId: string, key: string, value: string): void {
  const now = new Date().toISOString();
  pgCache = getPgCache();
  pgCache.set(cacheKey(provider, modelId, key), {
    provider,
    modelId,
    overrideKey: key,
    value,
    refreshedAt: now,
  });
  pgCacheLoadedAt = Date.now();
  pgCacheEpoch++;

  void (async () => {
    try {
      await ensurePostgresBootstrap();
      await getKyselyDb()
        .insertInto("model_capability_overrides")
        .values({
          provider,
          model_id: modelId,
          override_key: key,
          override_value: value,
          refreshed_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["provider", "model_id", "override_key"]).doUpdateSet((eb) => ({
            override_value: eb.ref("excluded.override_value"),
            refreshed_at: eb.ref("excluded.refreshed_at"),
          }))
        )
        .execute();
    } catch (err) {
      log.warn("model_capability_overrides.pg_persist_failed", {
        provider,
        modelId,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function persistPgDelete(provider: string, modelId: string, key: string): void {
  pgCache = getPgCache();
  const existed = pgCache.delete(cacheKey(provider, modelId, key));
  if (!existed) return;
  pgCacheLoadedAt = Date.now();
  pgCacheEpoch++;

  void (async () => {
    try {
      await ensurePostgresBootstrap();
      await getKyselyDb()
        .deleteFrom("model_capability_overrides")
        .where("provider", "=", provider)
        .where("model_id", "=", modelId)
        .where("override_key", "=", key)
        .execute();
    } catch (err) {
      log.warn("model_capability_overrides.pg_delete_failed", {
        provider,
        modelId,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

export type ModelCapabilityOverrideKey = "max_token";

export interface ModelCapabilityOverride {
  provider: string;
  modelId: string;
  target: string;
  key: ModelCapabilityOverrideKey;
  value: number;
  refreshedAt: string;
}

interface OverrideRow {
  provider: string;
  model_id: string;
  override_key: string;
  override_value: string;
  refreshed_at: string;
}

function isSupportedKey(value: unknown): value is ModelCapabilityOverrideKey {
  return value === "max_token";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseModelOverrideTarget(
  target: unknown
): { provider: string; modelId: string } | null {
  const raw = typeof target === "string" ? target.trim() : "";
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex === raw.length - 1) return null;

  const provider = raw.slice(0, slashIndex).trim();
  const modelId = raw.slice(slashIndex + 1).trim();
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

function toOverride(row: OverrideRow): ModelCapabilityOverride | null {
  if (!isSupportedKey(row.override_key)) return null;

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(row.override_value);
  } catch {
    return null;
  }

  if (!isPositiveInteger(parsedValue)) return null;

  return {
    provider: row.provider,
    modelId: row.model_id,
    target: `${row.provider}/${row.model_id}`,
    key: row.override_key,
    value: parsedValue,
    refreshedAt: row.refreshed_at,
  };
}

export function getModelCapabilityOverride(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  key: ModelCapabilityOverrideKey
): number | null {
  const target = parseModelOverrideTarget(`${provider || ""}/${modelId || ""}`);
  if (!target || !isSupportedKey(key)) return null;

  if (isPostgres()) {
    const cached = getPgCache().get(cacheKey(target.provider, target.modelId, key));
    if (!cached) return null;
    const override = toOverride({
      provider: target.provider,
      model_id: target.modelId,
      override_key: key,
      override_value: cached.value,
      refreshed_at: cached.refreshedAt,
    });
    return override?.value ?? null;
  }

  try {
    const row = getDbInstance()
      .prepare(
        "SELECT provider, model_id, override_key, override_value, refreshed_at " +
          "FROM model_capability_overrides WHERE provider = ? AND model_id = ? AND override_key = ?"
      )
      .get(target.provider, target.modelId, key) as OverrideRow | undefined;
    const override = row ? toOverride(row) : null;
    return override?.value ?? null;
  } catch {
    return null;
  }
}

export function setModelCapabilityOverride(
  target: string,
  key: ModelCapabilityOverrideKey,
  value: number
): boolean {
  const parsedTarget = parseModelOverrideTarget(target);
  if (!parsedTarget || !isSupportedKey(key) || !isPositiveInteger(value)) return false;

  if (isPostgres()) {
    persistPgUpsert(parsedTarget.provider, parsedTarget.modelId, key, JSON.stringify(value));
    return true;
  }

  getDbInstance()
    .prepare(
      "INSERT OR REPLACE INTO model_capability_overrides " +
        "(provider, model_id, override_key, override_value, refreshed_at) " +
        "VALUES (?, ?, ?, ?, datetime('now'))"
    )
    .run(parsedTarget.provider, parsedTarget.modelId, key, JSON.stringify(value));
  return true;
}

export function removeModelCapabilityOverride(
  target: string,
  key: ModelCapabilityOverrideKey
): boolean {
  const parsedTarget = parseModelOverrideTarget(target);
  if (!parsedTarget || !isSupportedKey(key)) return false;

  if (isPostgres()) {
    const existed = getPgCache().has(cacheKey(parsedTarget.provider, parsedTarget.modelId, key));
    persistPgDelete(parsedTarget.provider, parsedTarget.modelId, key);
    return existed;
  }

  const info = getDbInstance()
    .prepare(
      "DELETE FROM model_capability_overrides " +
        "WHERE provider = ? AND model_id = ? AND override_key = ?"
    )
    .run(parsedTarget.provider, parsedTarget.modelId, key);
  return info.changes > 0;
}

export function listModelCapabilityOverrides(): ModelCapabilityOverride[] {
  if (isPostgres()) {
    const entries: ModelCapabilityOverride[] = [];
    for (const cached of getPgCache().values()) {
      const override = toOverride({
        provider: cached.provider,
        model_id: cached.modelId,
        override_key: cached.overrideKey,
        override_value: cached.value,
        refreshed_at: cached.refreshedAt,
      });
      if (override) entries.push(override);
    }
    entries.sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
    return entries;
  }

  try {
    const rows = getDbInstance()
      .prepare(
        "SELECT provider, model_id, override_key, override_value, refreshed_at " +
          "FROM model_capability_overrides ORDER BY refreshed_at DESC"
      )
      .all() as OverrideRow[];
    return rows.map(toOverride).filter((entry): entry is ModelCapabilityOverride => entry !== null);
  } catch {
    return [];
  }
}
