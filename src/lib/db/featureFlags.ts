/**
 * db/featureFlags.ts — Feature flag DB overrides.
 *
 * Stores per-flag override values in the key_value table under the
 * "feature_flags" namespace. When an override is present it takes precedence
 * over the process environment variable of the same name.
 */

import { FEATURE_FLAG_DEFINITIONS } from "@/shared/constants/featureFlagDefinitions";
import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("DB_FEATURE_FLAGS");
const NAMESPACE = "feature_flags";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

/**
 * In-memory cache of Postgres-backed overrides.
 *
 * getFeatureFlagOverride()/getFeatureFlagOverrides() MUST stay synchronous —
 * their caller chain (src/shared/utils/featureFlags.ts::isFeatureFlagEnabled)
 * is invoked synchronously from hot-path security/guardrail code (PII
 * masking, auth checks) that cannot become async. Overrides are rare,
 * operator-triggered admin actions, so a short staleness window across
 * multiple server instances — and a best-effort, fire-and-forget write to
 * Postgres on set/remove/clear — is an accepted trade-off (see the operator
 * decision recorded in the Postgres-adapter plan doc).
 */
let pgCache: Record<string, string> | null = null;
let pgCacheLoadedAt = 0;
let pgCacheLoadInFlight: Promise<void> | null = null;
// Monotonic write counter — used (instead of Date.now(), which only has
// millisecond resolution) to detect whether a local write raced against an
// in-flight background refresh. Two Date.now() calls a few synchronous
// statements apart can return the identical millisecond, which made an
// earlier version of this guard silently misfire.
let pgCacheEpoch = 0;
const PG_CACHE_TTL_MS = 30_000;

function refreshPgCacheInBackground(): void {
  if (pgCacheLoadInFlight) return;
  // Guard against a race where this refresh was queued BEFORE a local write
  // (setFeatureFlagOverride/remove/clear) but resolves AFTER it: without
  // this check, applying `next` here would silently clobber the newer
  // optimistic value with the stale pre-write snapshot this query read.
  const epochAtStart = pgCacheEpoch;
  pgCacheLoadInFlight = (async () => {
    try {
      await ensurePostgresBootstrap();
      const rows = await getKyselyDb()
        .selectFrom("key_value")
        .select(["key", "value"])
        .where("namespace", "=", NAMESPACE)
        .execute();
      const next: Record<string, string> = {};
      for (const row of rows) {
        next[row.key] = row.value;
      }
      if (pgCacheEpoch === epochAtStart) {
        pgCache = next;
        pgCacheLoadedAt = Date.now();
      }
    } catch (err) {
      // Leave the previous cache (or null) in place — every reader falls
      // back to process.env / the definition default regardless.
      log.warn("feature_flags.pg_cache_refresh_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pgCacheLoadInFlight = null;
    }
  })();
}

function getPgCache(): Record<string, string> {
  if (pgCache === null || Date.now() - pgCacheLoadedAt > PG_CACHE_TTL_MS) {
    refreshPgCacheInBackground();
  }
  return pgCache ?? {};
}

async function persistPgOverride(key: string, value: string): Promise<void> {
  try {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: NAMESPACE, key, value })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value }))
      .execute();
  } catch (err) {
    log.warn("feature_flags.pg_persist_failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function deletePgOverride(key?: string): Promise<void> {
  try {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().deleteFrom("key_value").where("namespace", "=", NAMESPACE);
    if (key !== undefined) query = query.where("key", "=", key);
    await query.execute();
  } catch (err) {
    log.warn("feature_flags.pg_delete_failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns all feature flag overrides as a key→value map.
 */
export function getFeatureFlagOverrides(): Record<string, string> {
  if (isPostgres()) {
    return { ...getPgCache() };
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as Array<{ key: string; value: string }>;

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Returns the override value for a single flag, or undefined if no override
 * is stored.
 */
export function getFeatureFlagOverride(key: string): string | undefined {
  if (isPostgres()) {
    return getPgCache()[key];
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Persists (or replaces) an override for a single flag.
 */
export function setFeatureFlagOverride(key: string, value: string): void {
  const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
  if (!definition) {
    throw new Error(`Unknown feature flag key: ${key}`);
  }
  if (
    definition.type === "enum" &&
    definition.enumValues &&
    !definition.enumValues.includes(value)
  ) {
    throw new Error(
      `Invalid value "${value}" for enum flag ${key}. Allowed: ${definition.enumValues.join(", ")}`
    );
  }

  if (isPostgres()) {
    // Update the cache optimistically so a read immediately after this call
    // sees the new value, then persist to Postgres in the background.
    pgCache = { ...(pgCache ?? {}), [key]: value };
    pgCacheLoadedAt = Date.now();
    pgCacheEpoch++;
    void persistPgOverride(key, value);
    return;
  }

  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    key,
    value
  );
}

/**
 * Removes the override for a single flag, restoring env-var / default
 * behaviour.
 */
export function removeFeatureFlagOverride(key: string): void {
  if (isPostgres()) {
    const next = { ...(pgCache ?? {}) };
    delete next[key];
    pgCache = next;
    pgCacheLoadedAt = Date.now();
    pgCacheEpoch++;
    void deletePgOverride(key);
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(NAMESPACE, key);
}

/**
 * Removes all stored feature flag overrides.
 */
export function clearAllFeatureFlagOverrides(): void {
  if (isPostgres()) {
    pgCache = {};
    pgCacheLoadedAt = Date.now();
    pgCacheEpoch++;
    void deletePgOverride();
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = ?").run(NAMESPACE);
}
