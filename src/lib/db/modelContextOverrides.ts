import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("DB_MODEL_CONTEXT_OVERRIDES");

/**
 * Feature 5004 — self-correcting context-window overrides.
 *
 * A persisted override of a model's real context window that wins over the static
 * catalog / models.dev sync in `getModelContextLimit()`. Two sources:
 * - `manual`: operator-set; never overwritten by the auto reconciler.
 * - `auto:discovery`: written by the reconciler when a provider's own `/models`
 *   discovery declares a window that diverges from the catalog.
 *
 * Cacheless on purpose under SQLite: the read path already touches the DB
 * (synced capabilities), and a single indexed PK lookup is negligible — this
 * avoids any cache-staleness hazard with `resetDbInstance()` in tests.
 *
 * Under DB_DRIVER=postgres, getModelContextOverride() is still read from the
 * hot-path context-window resolution in contextWindowResolver.ts and cannot
 * become async without a much larger ripple, so it falls back to the same
 * sync-preserving epoch-counter cache pattern used by
 * modelCapabilityOverrides.ts/featureFlags.ts/cliToolState.ts.
 */

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

/** In-memory cache of Postgres-backed model_context_overrides rows, keyed by "provider/modelId". */
let pgCache: Map<string, ModelContextOverride> | null = null;
let pgCacheLoadedAt = 0;
let pgCacheLoadInFlight: Promise<void> | null = null;
let pgCacheEpoch = 0;
const PG_CACHE_TTL_MS = 30_000;

function cacheKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

function refreshPgCacheInBackground(): void {
  if (pgCacheLoadInFlight) return;
  const epochAtStart = pgCacheEpoch;
  pgCacheLoadInFlight = (async () => {
    try {
      await ensurePostgresBootstrap();
      const rows = await getKyselyDb()
        .selectFrom("model_context_overrides")
        .select(["provider", "model_id", "real_context", "source", "refreshed_at"])
        .execute();
      const next = new Map<string, ModelContextOverride>();
      for (const row of rows) {
        // node-postgres returns BIGINT (real_context) as a string.
        next.set(
          cacheKey(row.provider, row.model_id),
          toOverride({ ...row, real_context: Number(row.real_context) })
        );
      }
      if (pgCacheEpoch === epochAtStart) {
        pgCache = next;
        pgCacheLoadedAt = Date.now();
      }
    } catch (err) {
      log.warn("model_context_overrides.pg_cache_refresh_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pgCacheLoadInFlight = null;
    }
  })();
}

function getPgCache(): Map<string, ModelContextOverride> {
  if (pgCache === null || Date.now() - pgCacheLoadedAt > PG_CACHE_TTL_MS) {
    refreshPgCacheInBackground();
  }
  return pgCache ?? new Map();
}

function persistPgUpsert(override: ModelContextOverride): void {
  pgCache = getPgCache();
  pgCache.set(cacheKey(override.provider, override.modelId), override);
  pgCacheLoadedAt = Date.now();
  pgCacheEpoch++;

  void (async () => {
    try {
      await ensurePostgresBootstrap();
      await getKyselyDb()
        .insertInto("model_context_overrides")
        .values({
          provider: override.provider,
          model_id: override.modelId,
          real_context: override.realContext,
          source: override.source,
          refreshed_at: override.refreshedAt,
        })
        .onConflict((oc) =>
          oc.columns(["provider", "model_id"]).doUpdateSet((eb) => ({
            real_context: eb.ref("excluded.real_context"),
            source: eb.ref("excluded.source"),
            refreshed_at: eb.ref("excluded.refreshed_at"),
          }))
        )
        .execute();
    } catch (err) {
      log.warn("model_context_overrides.pg_persist_failed", {
        provider: override.provider,
        modelId: override.modelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function persistPgDelete(provider: string, modelId: string): void {
  pgCache = getPgCache();
  const existed = pgCache.delete(cacheKey(provider, modelId));
  if (!existed) return;
  pgCacheLoadedAt = Date.now();
  pgCacheEpoch++;

  void (async () => {
    try {
      await ensurePostgresBootstrap();
      await getKyselyDb()
        .deleteFrom("model_context_overrides")
        .where("provider", "=", provider)
        .where("model_id", "=", modelId)
        .execute();
    } catch (err) {
      log.warn("model_context_overrides.pg_delete_failed", {
        provider,
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

export type ModelContextOverrideSource = "manual" | "auto:discovery";

export interface ModelContextOverride {
  provider: string;
  modelId: string;
  realContext: number;
  source: ModelContextOverrideSource;
  refreshedAt: string;
}

interface OverrideRow {
  provider: string;
  model_id: string;
  real_context: number;
  source: string;
  refreshed_at: string;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeKey(
  provider: unknown,
  modelId: unknown
): { provider: string; modelId: string } | null {
  const p = typeof provider === "string" ? provider.trim() : "";
  const m = typeof modelId === "string" ? modelId.trim() : "";
  if (!p || !m) return null;
  return { provider: p, modelId: m };
}

function toOverride(row: OverrideRow): ModelContextOverride {
  return {
    provider: row.provider,
    modelId: row.model_id,
    realContext: row.real_context,
    source: row.source === "auto:discovery" ? "auto:discovery" : "manual",
    refreshedAt: row.refreshed_at,
  };
}

/** Full override record for (provider, modelId), or null. Never throws. */
export function getModelContextOverrideRecord(
  provider: string | null | undefined,
  modelId: string | null | undefined
): ModelContextOverride | null {
  const key = normalizeKey(provider, modelId);
  if (!key) return null;

  if (isPostgres()) {
    return getPgCache().get(cacheKey(key.provider, key.modelId)) ?? null;
  }

  try {
    const row = getDbInstance()
      .prepare(
        "SELECT provider, model_id, real_context, source, refreshed_at " +
          "FROM model_context_overrides WHERE provider = ? AND model_id = ?"
      )
      .get(key.provider, key.modelId) as OverrideRow | undefined;
    return row ? toOverride(row) : null;
  } catch {
    // Table may not exist yet (pre-migration) — fall through to the catalog.
    return null;
  }
}

/** The overridden context window (tokens) for (provider, modelId), or null. Never throws. */
export function getModelContextOverride(
  provider: string | null | undefined,
  modelId: string | null | undefined
): number | null {
  const record = getModelContextOverrideRecord(provider, modelId);
  return record ? record.realContext : null;
}

/**
 * Upsert an override. `realContext` must be a positive integer (a token count);
 * anything else is rejected (no write). Returns true when a row was written.
 */
export function setModelContextOverride(
  provider: string,
  modelId: string,
  realContext: number,
  source: ModelContextOverrideSource = "manual"
): boolean {
  const key = normalizeKey(provider, modelId);
  if (!key || !isPositiveInteger(realContext)) return false;
  const normalizedSource: ModelContextOverrideSource =
    source === "auto:discovery" ? "auto:discovery" : "manual";

  if (isPostgres()) {
    persistPgUpsert({
      provider: key.provider,
      modelId: key.modelId,
      realContext,
      source: normalizedSource,
      refreshedAt: new Date().toISOString(),
    });
    return true;
  }

  getDbInstance()
    .prepare(
      "INSERT OR REPLACE INTO model_context_overrides " +
        "(provider, model_id, real_context, source, refreshed_at) " +
        "VALUES (?, ?, ?, ?, datetime('now'))"
    )
    .run(key.provider, key.modelId, realContext, normalizedSource);
  return true;
}

/** Remove an override. Returns true when a row was deleted. */
export function removeModelContextOverride(provider: string, modelId: string): boolean {
  const key = normalizeKey(provider, modelId);
  if (!key) return false;

  if (isPostgres()) {
    const existed = getPgCache().has(cacheKey(key.provider, key.modelId));
    persistPgDelete(key.provider, key.modelId);
    return existed;
  }

  const info = getDbInstance()
    .prepare("DELETE FROM model_context_overrides WHERE provider = ? AND model_id = ?")
    .run(key.provider, key.modelId);
  return info.changes > 0;
}

/** All overrides, newest refresh first. Never throws. */
export function listModelContextOverrides(): ModelContextOverride[] {
  if (isPostgres()) {
    return [...getPgCache().values()].sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
  }

  try {
    const rows = getDbInstance()
      .prepare(
        "SELECT provider, model_id, real_context, source, refreshed_at " +
          "FROM model_context_overrides ORDER BY refreshed_at DESC"
      )
      .all() as OverrideRow[];
    return rows.map(toOverride);
  } catch {
    return [];
  }
}
