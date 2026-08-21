/**
 * CLI Tool State Persistence
 *
 * Stores last-configured timestamps and initial config snapshots
 * for CLI tools in the key_value table.
 *
 * Namespaces:
 *   - cliToolLastConfig: ISO timestamp of last configuration
 *   - cliToolInitialConfig: JSON snapshot of pre-OmniRoute configuration
 *
 * @module lib/db/cliToolState
 */

import { getDbInstance, isBuildPhase, isCloud } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("DB_CLI_TOOL_STATE");

type JsonRecord = Record<string, unknown>;

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

/**
 * In-memory, per-namespace cache of Postgres-backed key_value rows.
 *
 * Every export here MUST stay synchronous — callers (14+ CLI settings
 * routes, the CLI status routes) invoke them from plain synchronous code
 * paths that never await. Mirrors the same trade-off already accepted for
 * src/lib/db/featureFlags.ts: a short staleness window across multiple
 * server instances, and best-effort fire-and-forget Postgres writes.
 */
const pgCache = new Map<string, Record<string, string>>();
const pgCacheLoadedAt = new Map<string, number>();
const pgCacheLoadInFlight = new Map<string, Promise<void>>();
// Monotonic write counter per namespace — used (instead of Date.now(), which
// only has millisecond resolution) to detect whether a local write raced
// against an in-flight background refresh. Two Date.now() calls a few
// synchronous statements apart can return the identical millisecond, which
// made an earlier version of this guard silently misfire.
const pgCacheEpoch = new Map<string, number>();
const PG_CACHE_TTL_MS = 30_000;

function refreshPgCacheInBackground(namespace: string): void {
  if (pgCacheLoadInFlight.has(namespace)) return;
  // Guard against a race where this refresh was queued BEFORE a local write
  // (setPgCacheValue/deletePgCacheValue) but resolves AFTER it: without this
  // check, applying `next` here would silently clobber the newer optimistic
  // value with the stale pre-write snapshot this query actually read.
  const epochAtStart = pgCacheEpoch.get(namespace) ?? 0;
  const promise = (async () => {
    try {
      await ensurePostgresBootstrap();
      const rows = await getKyselyDb()
        .selectFrom("key_value")
        .select(["key", "value"])
        .where("namespace", "=", namespace)
        .execute();
      const next: Record<string, string> = {};
      for (const row of rows) {
        next[row.key] = row.value;
      }
      if ((pgCacheEpoch.get(namespace) ?? 0) === epochAtStart) {
        pgCache.set(namespace, next);
        pgCacheLoadedAt.set(namespace, Date.now());
      }
    } catch (err) {
      log.warn("cli_tool_state.pg_cache_refresh_failed", {
        namespace,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pgCacheLoadInFlight.delete(namespace);
    }
  })();
  pgCacheLoadInFlight.set(namespace, promise);
}

function getPgNamespaceCache(namespace: string): Record<string, string> {
  const loadedAt = pgCacheLoadedAt.get(namespace) ?? 0;
  if (!pgCache.has(namespace) || Date.now() - loadedAt > PG_CACHE_TTL_MS) {
    refreshPgCacheInBackground(namespace);
  }
  return pgCache.get(namespace) ?? {};
}

async function persistPgValue(namespace: string, key: string, value: string): Promise<void> {
  try {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace, key, value })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value }))
      .execute();
  } catch (err) {
    log.warn("cli_tool_state.pg_persist_failed", {
      namespace,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function setPgCacheValue(namespace: string, key: string, value: string): void {
  const current = pgCache.get(namespace) ?? {};
  pgCache.set(namespace, { ...current, [key]: value });
  pgCacheLoadedAt.set(namespace, Date.now());
  pgCacheEpoch.set(namespace, (pgCacheEpoch.get(namespace) ?? 0) + 1);
}

async function deletePgValue(namespace: string, key: string): Promise<void> {
  try {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("key_value")
      .where("namespace", "=", namespace)
      .where("key", "=", key)
      .execute();
  } catch (err) {
    log.warn("cli_tool_state.pg_delete_failed", {
      namespace,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function deletePgCacheValue(namespace: string, key: string): void {
  const current = pgCache.get(namespace) ?? {};
  const next = { ...current };
  delete next[key];
  pgCache.set(namespace, next);
  pgCacheLoadedAt.set(namespace, Date.now());
  pgCacheEpoch.set(namespace, (pgCacheEpoch.get(namespace) ?? 0) + 1);
}

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

interface KeyValueRow {
  key: string;
  value: string;
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// ──────────────── Last Configured Timestamp ────────────────

/**
 * Save last-configured timestamp for a CLI tool.
 */
export function saveCliToolLastConfigured(
  toolId: string,
  timestamp: string = new Date().toISOString()
): void {
  if (isBuildPhase || isCloud) return;
  const raw = JSON.stringify(timestamp);

  if (isPostgres()) {
    setPgCacheValue("cliToolLastConfig", toolId, raw);
    void persistPgValue("cliToolLastConfig", toolId, raw);
    return;
  }

  const db = getDbInstance() as unknown as DbLike;
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    "cliToolLastConfig",
    toolId,
    raw
  );
}

/**
 * Get last-configured timestamp for a CLI tool.
 * @returns ISO timestamp string or null if never configured.
 */
export function getCliToolLastConfigured(toolId: string): string | null {
  if (isBuildPhase || isCloud) return null;

  if (isPostgres()) {
    const raw = getPgNamespaceCache("cliToolLastConfig")[toolId];
    if (raw === undefined) return null;
    const parsed = parseJsonValue(raw);
    return typeof parsed === "string" ? parsed : null;
  }

  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get("cliToolLastConfig", toolId);
  if (!row) return null;
  const parsed = parseJsonValue((row as KeyValueRow).value);
  return typeof parsed === "string" ? parsed : null;
}

/**
 * Get all CLI tool last-configured timestamps.
 * @returns Record<toolId, ISO timestamp>
 */
export function getAllCliToolLastConfigured(): Record<string, string> {
  if (isBuildPhase || isCloud) return {};

  if (isPostgres()) {
    const cache = getPgNamespaceCache("cliToolLastConfig");
    const result: Record<string, string> = {};
    for (const [key, raw] of Object.entries(cache)) {
      const parsed = parseJsonValue(raw);
      if (typeof parsed === "string") result[key] = parsed;
    }
    return result;
  }

  const db = getDbInstance() as unknown as DbLike;
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all("cliToolLastConfig") as KeyValueRow[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    const parsed = parseJsonValue(row.value);
    if (typeof parsed === "string") {
      result[row.key] = parsed;
    }
  }
  return result;
}

/**
 * Delete last-configured timestamp for a CLI tool.
 */
export function deleteCliToolLastConfigured(toolId: string): void {
  if (isBuildPhase || isCloud) return;

  if (isPostgres()) {
    deletePgCacheValue("cliToolLastConfig", toolId);
    void deletePgValue("cliToolLastConfig", toolId);
    return;
  }

  const db = getDbInstance() as unknown as DbLike;
  db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
    "cliToolLastConfig",
    toolId
  );
}

// ──────────────── Initial Config Snapshot ────────────────

/**
 * Save the initial (pre-OmniRoute) config snapshot for a CLI tool.
 * Only saves if no snapshot exists yet (first-time only).
 * @returns true if saved, false if snapshot already exists.
 */
export function saveCliToolInitialConfig(toolId: string, config: JsonRecord): boolean {
  if (isBuildPhase || isCloud) return false;

  if (isPostgres()) {
    // Only save if not already stored. Relies on the same cache as every
    // other read here — on a cold/stale cache this can theoretically
    // re-save over a real snapshot from another instance; not currently
    // reachable from production code (only saveCliToolInitialConfig's own
    // tests call it), so this is an accepted, documented gap rather than a
    // live risk.
    const cache = getPgNamespaceCache("cliToolInitialConfig");
    if (cache[toolId] !== undefined) return false;

    const raw = JSON.stringify(config);
    setPgCacheValue("cliToolInitialConfig", toolId, raw);
    void persistPgValue("cliToolInitialConfig", toolId, raw);
    return true;
  }

  const db = getDbInstance() as unknown as DbLike;
  // Only save if not already stored
  const existing = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get("cliToolInitialConfig", toolId);
  if (existing) return false;

  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    "cliToolInitialConfig",
    toolId,
    JSON.stringify(config)
  );
  return true;
}

/**
 * Get the initial config snapshot for a CLI tool.
 * @returns Config object or null if no snapshot exists.
 */
export function getCliToolInitialConfig(toolId: string): JsonRecord | null {
  if (isBuildPhase || isCloud) return null;

  if (isPostgres()) {
    const raw = getPgNamespaceCache("cliToolInitialConfig")[toolId];
    if (raw === undefined) return null;
    return toRecord(parseJsonValue(raw));
  }

  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get("cliToolInitialConfig", toolId);
  if (!row) return null;
  const parsed = parseJsonValue((row as KeyValueRow).value);
  return toRecord(parsed);
}

/**
 * Delete the initial config snapshot for a CLI tool.
 */
export function deleteCliToolInitialConfig(toolId: string): void {
  if (isBuildPhase || isCloud) return;

  if (isPostgres()) {
    deletePgCacheValue("cliToolInitialConfig", toolId);
    void deletePgValue("cliToolInitialConfig", toolId);
    return;
  }

  const db = getDbInstance() as unknown as DbLike;
  db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
    "cliToolInitialConfig",
    toolId
  );
}
