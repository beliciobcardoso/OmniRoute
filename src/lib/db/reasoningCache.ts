/**
 * reasoningCache.ts — DB domain module for the Reasoning Replay Cache.
 *
 * Persists reasoning_content from thinking-mode models (DeepSeek V4, Kimi K2,
 * Qwen-Thinking, etc.) keyed by tool_call_id. Used for crash recovery and
 * dashboard visibility. The hot path uses the in-memory cache in
 * open-sse/services/reasoningCache.ts; this module is the persistence layer.
 *
 * getReasoningCache (the synchronous DB-fallback read used by
 * open-sse/services/reasoningCache.ts's lookupReasoning) stays SQLite-only:
 * it is called synchronously deep inside the translator's per-message loops
 * (open-sse/translator/index.ts, translator/helpers/claudeHelper.ts), which
 * are not async — the same hot-path-must-stay-sync constraint documented for
 * modelIntelligence.ts/quotaSnapshots.ts elsewhere in this effort. Under
 * Postgres this DB fallback is a no-op (returns null immediately) — lookups
 * rely solely on the 200-entry/2h-TTL in-memory cache, a documented
 * degradation, not a correctness bug. Every other export (writes, cleanup,
 * stats, paginated listing) is converted to async dual-dialect.
 *
 * @see Issue #1628
 */

import { sql } from "kysely";

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// ──────────────── Types ────────────────

export interface ReasoningCacheEntry {
  toolCallId: string;
  provider: string;
  model: string;
  reasoning: string;
  charCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface ReasoningCacheStats {
  totalEntries: number;
  totalChars: number;
  byProvider: Record<string, { entries: number; chars: number }>;
  byModel: Record<string, { entries: number; chars: number }>;
  oldestEntry: string | null;
  newestEntry: string | null;
}

// ──────────────── Constants ────────────────

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function toUnixEpochSeconds(dateMs: number): number {
  return Math.floor(dateMs / 1000);
}

const EXPIRES_AT_EPOCH_SQL = `COALESCE(
  CASE
    WHEN typeof(expires_at) IN ('integer', 'real') THEN CAST(expires_at AS INTEGER)
    WHEN typeof(expires_at) = 'text' AND expires_at <> '' AND expires_at NOT GLOB '*[^0-9]*'
      THEN CAST(expires_at AS INTEGER)
    ELSE unixepoch(expires_at)
  END,
  0
)`;

function epochSecondsToIso(value: number | string): string {
  const text = String(value);
  const seconds =
    typeof value === "number" || (text !== "" && !/[^0-9]/.test(text))
      ? Number.parseInt(text, 10)
      : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  const parsedMs = Date.parse(text);
  if (Number.isFinite(parsedMs)) {
    return new Date(parsedMs).toISOString();
  }
  return String(value);
}

const MAX_ENTRY_BYTES = 10000;

// ──────────────── CRUD ────────────────

/**
 * Store a reasoning_content entry for a given tool_call_id.
 * Uses INSERT OR REPLACE to handle duplicate tool_call_ids gracefully.
 */
export async function setReasoningCache(
  toolCallId: string,
  provider: string,
  model: string,
  reasoning: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<void> {
  if (reasoning.length > MAX_ENTRY_BYTES) {
    reasoning = reasoning.slice(0, MAX_ENTRY_BYTES);
  }
  const expiresAt = toUnixEpochSeconds(Date.now() + ttlMs);
  const charCount = reasoning.length;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const nowIso = sql<string>`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
    await kdb
      .insertInto("reasoning_cache")
      .values({
        tool_call_id: toolCallId,
        provider,
        model,
        reasoning,
        char_count: charCount,
        created_at: nowIso,
        expires_at: expiresAt,
      })
      .onConflict((oc) =>
        oc.column("tool_call_id").doUpdateSet({
          provider: (eb) => eb.ref("excluded.provider"),
          model: (eb) => eb.ref("excluded.model"),
          reasoning: (eb) => eb.ref("excluded.reasoning"),
          char_count: (eb) => eb.ref("excluded.char_count"),
          created_at: () => nowIso,
          expires_at: (eb) => eb.ref("excluded.expires_at"),
        })
      )
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `INSERT OR REPLACE INTO reasoning_cache
       (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
  ).run(toolCallId, provider, model, reasoning, charCount, expiresAt);
}

/**
 * Retrieve a cached reasoning_content by tool_call_id.
 * Returns null if not found or expired.
 */
export function getReasoningCache(
  toolCallId: string
): { reasoning: string; provider: string; model: string } | null {
  if (isPostgres()) {
    // DB fallback disabled under Postgres — this read is called synchronously
    // from the translator's hot path (see module docstring); lookups rely
    // solely on the in-memory cache in open-sse/services/reasoningCache.ts.
    return null;
  }
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT reasoning, provider, model FROM reasoning_cache
       WHERE tool_call_id = ? AND ${EXPIRES_AT_EPOCH_SQL} > unixepoch('now')`
    )
    .get(toolCallId) as { reasoning: string; provider: string; model: string } | undefined;

  return row ?? null;
}

/**
 * Delete a specific reasoning cache entry.
 */
export async function deleteReasoningCache(toolCallId: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("reasoning_cache")
      .where("tool_call_id", "=", toolCallId)
      .executeTakeFirst();
    return toInt(result.numDeletedRows);
  }
  const db = getDbInstance();
  const result = db.prepare(`DELETE FROM reasoning_cache WHERE tool_call_id = ?`).run(toolCallId);
  return result.changes;
}

/**
 * Delete all expired entries. Returns count of rows removed.
 */
export async function cleanupExpiredReasoning(): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("reasoning_cache")
      .where(sql<boolean>`expires_at <= extract(epoch from now())`)
      .executeTakeFirst();
    return toInt(result.numDeletedRows);
  }
  const db = getDbInstance();
  const result = db
    .prepare(`DELETE FROM reasoning_cache WHERE ${EXPIRES_AT_EPOCH_SQL} <= unixepoch('now')`)
    .run();
  return result.changes;
}

/**
 * Delete all entries, optionally filtered by provider.
 * Returns count of rows removed.
 */
export async function clearAllReasoningCache(provider?: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    let query = kdb.deleteFrom("reasoning_cache");
    if (provider) {
      query = query.where("provider", "=", provider);
    }
    const result = await query.executeTakeFirst();
    return toInt(result.numDeletedRows);
  }
  const db = getDbInstance();
  if (provider) {
    const result = db.prepare(`DELETE FROM reasoning_cache WHERE provider = ?`).run(provider);
    return result.changes;
  }
  const result = db.prepare(`DELETE FROM reasoning_cache`).run();
  return result.changes;
}

// ──────────────── Stats ────────────────

/**
 * Get aggregate statistics for the reasoning cache.
 */
export async function getReasoningCacheStats(): Promise<ReasoningCacheStats> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const notExpired = sql<boolean>`expires_at > extract(epoch from now())`;

    const totals = await kdb
      .selectFrom("reasoning_cache")
      .select((eb) => [
        eb.fn.countAll<string>().as("total_entries"),
        eb.fn.coalesce(eb.fn.sum<number>("char_count"), eb.val(0)).as("total_chars"),
      ])
      .where(notExpired)
      .executeTakeFirstOrThrow();

    const providerRows = await kdb
      .selectFrom("reasoning_cache")
      .select((eb) => [
        "provider",
        eb.fn.countAll<string>().as("entries"),
        eb.fn.coalesce(eb.fn.sum<number>("char_count"), eb.val(0)).as("chars"),
      ])
      .where(notExpired)
      .groupBy("provider")
      .orderBy("entries", "desc")
      .execute();

    const byProvider: Record<string, { entries: number; chars: number }> = {};
    for (const row of providerRows) {
      byProvider[row.provider] = { entries: toInt(row.entries), chars: toInt(row.chars) };
    }

    const modelRows = await kdb
      .selectFrom("reasoning_cache")
      .select((eb) => [
        "model",
        eb.fn.countAll<string>().as("entries"),
        eb.fn.coalesce(eb.fn.sum<number>("char_count"), eb.val(0)).as("chars"),
      ])
      .where(notExpired)
      .groupBy("model")
      .orderBy("entries", "desc")
      .execute();

    const byModel: Record<string, { entries: number; chars: number }> = {};
    for (const row of modelRows) {
      byModel[row.model] = { entries: toInt(row.entries), chars: toInt(row.chars) };
    }

    const oldest = await kdb
      .selectFrom("reasoning_cache")
      .select("created_at")
      .where(notExpired)
      .orderBy("created_at", "asc")
      .limit(1)
      .executeTakeFirst();

    const newest = await kdb
      .selectFrom("reasoning_cache")
      .select("created_at")
      .where(notExpired)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return {
      totalEntries: toInt(totals.total_entries),
      totalChars: toInt(totals.total_chars),
      byProvider,
      byModel,
      oldestEntry: oldest?.created_at ?? null,
      newestEntry: newest?.created_at ?? null,
    };
  }

  const db = getDbInstance();

  // Total counts
  const totals = db
    .prepare(
      `SELECT COUNT(*) as total_entries, COALESCE(SUM(char_count), 0) as total_chars
       FROM reasoning_cache WHERE ${EXPIRES_AT_EPOCH_SQL} > unixepoch('now')`
    )
    .get() as { total_entries: number; total_chars: number };

  // By provider
  const providerRows = db
    .prepare(
      `SELECT provider, COUNT(*) as entries, COALESCE(SUM(char_count), 0) as chars
       FROM reasoning_cache WHERE ${EXPIRES_AT_EPOCH_SQL} > unixepoch('now')
       GROUP BY provider ORDER BY entries DESC`
    )
    .all() as { provider: string; entries: number; chars: number }[];

  const byProvider: Record<string, { entries: number; chars: number }> = {};
  for (const row of providerRows) {
    byProvider[row.provider] = { entries: row.entries, chars: row.chars };
  }

  // By model
  const modelRows = db
    .prepare(
      `SELECT model, COUNT(*) as entries, COALESCE(SUM(char_count), 0) as chars
       FROM reasoning_cache WHERE ${EXPIRES_AT_EPOCH_SQL} > unixepoch('now')
       GROUP BY model ORDER BY entries DESC`
    )
    .all() as { model: string; entries: number; chars: number }[];

  const byModel: Record<string, { entries: number; chars: number }> = {};
  for (const row of modelRows) {
    byModel[row.model] = { entries: row.entries, chars: row.chars };
  }

  // Oldest/newest
  const oldest = db
    .prepare(
      `SELECT created_at FROM reasoning_cache
       WHERE ${EXPIRES_AT_EPOCH_SQL} > unixepoch('now') ORDER BY created_at ASC LIMIT 1`
    )
    .get() as { created_at: string } | undefined;

  const newest = db
    .prepare(
      `SELECT created_at FROM reasoning_cache
       WHERE ${EXPIRES_AT_EPOCH_SQL} > unixepoch('now') ORDER BY created_at DESC LIMIT 1`
    )
    .get() as { created_at: string } | undefined;

  return {
    totalEntries: totals.total_entries,
    totalChars: totals.total_chars,
    byProvider,
    byModel,
    oldestEntry: oldest?.created_at ?? null,
    newestEntry: newest?.created_at ?? null,
  };
}

// ──────────────── Paginated Entries ────────────────

/**
 * List reasoning cache entries with optional filters and pagination.
 */
export async function getReasoningCacheEntries(
  opts: {
    limit?: number;
    offset?: number;
    provider?: string;
    model?: string;
  } = {}
): Promise<ReasoningCacheEntry[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    let query = kdb
      .selectFrom("reasoning_cache")
      .select([
        "tool_call_id",
        "provider",
        "model",
        "reasoning",
        "char_count",
        "created_at",
        "expires_at",
      ])
      .where(sql<boolean>`expires_at > extract(epoch from now())`);

    if (opts.provider) {
      query = query.where("provider", "=", opts.provider);
    }
    if (opts.model) {
      query = query.where("model", "=", opts.model);
    }

    const rows = await query.orderBy("created_at", "desc").limit(limit).offset(offset).execute();

    return rows.map((row) => ({
      toolCallId: row.tool_call_id,
      provider: row.provider,
      model: row.model,
      reasoning: row.reasoning,
      charCount: toInt(row.char_count),
      createdAt: row.created_at,
      expiresAt: epochSecondsToIso(row.expires_at),
    }));
  }

  const db = getDbInstance();

  const conditions: string[] = [`${EXPIRES_AT_EPOCH_SQL} > unixepoch('now')`];
  const params: unknown[] = [];

  if (opts.provider) {
    conditions.push("provider = ?");
    params.push(opts.provider);
  }
  if (opts.model) {
    conditions.push("model = ?");
    params.push(opts.model);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT tool_call_id, provider, model, reasoning, char_count, created_at, expires_at
       FROM reasoning_cache ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as {
    tool_call_id: string;
    provider: string;
    model: string;
    reasoning: string;
    char_count: number;
    created_at: string;
    expires_at: number | string;
  }[];

  return rows.map((row) => ({
    toolCallId: row.tool_call_id,
    provider: row.provider,
    model: row.model,
    reasoning: row.reasoning,
    charCount: row.char_count,
    createdAt: row.created_at,
    expiresAt: epochSecondsToIso(row.expires_at),
  }));
}
