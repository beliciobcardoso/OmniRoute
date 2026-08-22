/**
 * db/quotaConsumption.ts — Sliding Window Counter primitives for quota tracking.
 *
 * Implements low-level bucket read/write operations for the 2-bucket sliding
 * window counter algorithm. Each row is keyed on (api_key_id, dimension_key,
 * bucket_index) where dimension_key = "<poolId>:<unit>:<window>" and
 * bucket_index = floor(now_ms / window_ms).
 *
 * Atomicity: incrementBucket uses INSERT ... ON CONFLICT DO UPDATE (UPSERT)
 * which is a single atomic statement under both dialects — no separate
 * read-modify-write.
 *
 * Part of: Group B — Quota Sharing Engine (plan 22, frente F2).
 */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

function getDb(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

interface BucketRow {
  consumed: number;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single consumption event row, as returned by listConsumptionForPool.
 * Derived from the quota_consumption table; the poolId is stripped from
 * dimension_key (format "<poolId>:<unit>:<window>") and the unit/window
 * fragments are surfaced separately.
 */
export interface ConsumptionEvent {
  apiKeyId: string;
  /** The full dimension_key string: "<poolId>:<unit>:<window>" */
  dimensionKey: string;
  /** The <unit> segment of dimension_key (e.g. "tokens", "requests", "usd") */
  unit: string;
  /** The <window> segment of dimension_key (e.g. "hourly", "daily") */
  window: string;
  bucketIndex: number;
  consumed: number;
  /** epoch ms */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the consumed value for a single bucket. Returns 0 if no row exists.
 */
export async function getBucket(
  apiKeyId: string,
  dimensionKey: string,
  bucketIndex: number
): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("quota_consumption")
      .select("consumed")
      .where("api_key_id", "=", apiKeyId)
      .where("dimension_key", "=", dimensionKey)
      .where("bucket_index", "=", bucketIndex)
      .executeTakeFirst();
    return toNumber(row?.consumed, 0);
  }

  const row = getDb()
    .prepare<BucketRow>(
      `SELECT consumed FROM quota_consumption
       WHERE api_key_id = ? AND dimension_key = ? AND bucket_index = ?`
    )
    .get(apiKeyId, dimensionKey, bucketIndex);
  return row?.consumed ?? 0;
}

/**
 * Atomically increment the consumed counter for a bucket.
 * Uses UPSERT: if the row does not exist it is created; if it exists the
 * delta is added to the existing consumed value and updated_at is refreshed.
 *
 * @param apiKeyId      The API key being tracked.
 * @param dimensionKey  "<poolId>:<unit>:<window>" string.
 * @param bucketIndex   floor(nowMs / windowMs).
 * @param delta         Amount to add (positive number).
 * @param nowMs         Current epoch milliseconds (used for updated_at).
 */
export async function incrementBucket(
  apiKeyId: string,
  dimensionKey: string,
  bucketIndex: number,
  delta: number,
  nowMs: number
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("quota_consumption")
      .values({
        api_key_id: apiKeyId,
        dimension_key: dimensionKey,
        bucket_index: bucketIndex,
        consumed: delta,
        updated_at: nowMs,
      })
      .onConflict((oc) =>
        oc.columns(["api_key_id", "dimension_key", "bucket_index"]).doUpdateSet((eb) => ({
          consumed: eb("quota_consumption.consumed", "+", eb.ref("excluded.consumed")),
          updated_at: eb.ref("excluded.updated_at"),
        }))
      )
      .execute();
    return;
  }

  getDb()
    .prepare(
      `INSERT INTO quota_consumption (api_key_id, dimension_key, bucket_index, consumed, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(api_key_id, dimension_key, bucket_index)
       DO UPDATE SET
         consumed = consumed + excluded.consumed,
         updated_at = excluded.updated_at`
    )
    .run(apiKeyId, dimensionKey, bucketIndex, delta, nowMs);
}

/**
 * Read the current and previous bucket values for the sliding window formula:
 *   effective = prev × (1 − elapsed/window) + curr
 *
 * @param apiKeyId      The API key being tracked.
 * @param dimensionKey  "<poolId>:<unit>:<window>" string.
 * @param currentBucket The current bucket index (floor(nowMs / windowMs)).
 * @returns             { curr, prev } — both default to 0 when row is absent.
 */
export async function getPair(
  apiKeyId: string,
  dimensionKey: string,
  currentBucket: number
): Promise<{ curr: number; prev: number }> {
  const prevBucket = currentBucket - 1;

  if (isPostgres()) {
    const [curr, prev] = await Promise.all([
      getBucket(apiKeyId, dimensionKey, currentBucket),
      getBucket(apiKeyId, dimensionKey, prevBucket),
    ]);
    return { curr, prev };
  }

  const currRow = getDb()
    .prepare<BucketRow>(
      `SELECT consumed FROM quota_consumption
       WHERE api_key_id = ? AND dimension_key = ? AND bucket_index = ?`
    )
    .get(apiKeyId, dimensionKey, currentBucket);

  const prevRow = getDb()
    .prepare<BucketRow>(
      `SELECT consumed FROM quota_consumption
       WHERE api_key_id = ? AND dimension_key = ? AND bucket_index = ?`
    )
    .get(apiKeyId, dimensionKey, prevBucket);

  return {
    curr: currRow?.consumed ?? 0,
    prev: prevRow?.consumed ?? 0,
  };
}

// ---------------------------------------------------------------------------
// List recent consumption for a pool
// ---------------------------------------------------------------------------

interface ConsumptionRow {
  api_key_id: string;
  dimension_key: string;
  bucket_index: number;
  consumed: number;
  updated_at: number;
}

/**
 * Return the most-recent consumption rows for a given pool, ordered by
 * updated_at DESC. The poolId is the first segment of dimension_key
 * (format "<poolId>:<unit>:<window>"), so we filter with a LIKE prefix.
 *
 * @param poolId  The quota pool identifier.
 * @param limit   Maximum rows to return (caller should clamp; default 50).
 * @returns       Array of ConsumptionEvent (may be empty if no data yet).
 */
export async function listConsumptionForPool(
  poolId: string,
  limit: number
): Promise<ConsumptionEvent[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  // dimension_key format: "<poolId>:<unit>:<window>"
  // The LIKE pattern uses "%" — escape literal "%" or "_" in poolId defensively.
  const prefix = poolId.replace(/[%_\\]/g, "\\$&") + ":%";

  let rows: ConsumptionRow[];

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const pgRows = await kdb
      .selectFrom("quota_consumption")
      .select(["api_key_id", "dimension_key", "bucket_index", "consumed", "updated_at"])
      .where("dimension_key", "like", prefix)
      .orderBy("updated_at", "desc")
      .limit(safeLimit)
      .execute();
    rows = pgRows.map((r) => ({
      api_key_id: r.api_key_id,
      dimension_key: r.dimension_key,
      bucket_index: toNumber(r.bucket_index),
      consumed: toNumber(r.consumed),
      updated_at: toNumber(r.updated_at),
    }));
  } else {
    rows = getDb()
      .prepare<ConsumptionRow>(
        `SELECT api_key_id, dimension_key, bucket_index, consumed, updated_at
         FROM quota_consumption
         WHERE dimension_key LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(prefix, safeLimit);
  }

  return rows.map((r) => {
    const parts = r.dimension_key.split(":");
    // parts[0] = poolId, parts[1] = unit, parts[2..] = window (rejoin in case window has colons)
    const unit = parts[1] ?? "";
    const window = parts.slice(2).join(":") ?? "";
    return {
      apiKeyId: r.api_key_id,
      dimensionKey: r.dimension_key,
      unit,
      window,
      bucketIndex: r.bucket_index,
      consumed: r.consumed,
      updatedAt: r.updated_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Pool-wide aggregate
// ---------------------------------------------------------------------------

/**
 * Sum the consumed values for a given (dimensionKey, currentBucketIndex) and
 * (dimensionKey, currentBucketIndex - 1) across ALL api_key_id values.
 *
 * Returns { currTotal, prevTotal } so the caller can apply the sliding-window
 * formula once with the pool-wide totals instead of summing per-key.
 *
 * @param dimensionKey   "<poolId>:<unit>:<window>" string — same format as consume/peek.
 * @param currentBucket  floor(nowMs / windowMs) — caller must pass the same value.
 */
export async function sumPoolDimension(
  dimensionKey: string,
  currentBucket: number
): Promise<{ currTotal: number; prevTotal: number }> {
  const prevBucket = currentBucket - 1;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const [currRow, prevRow] = await Promise.all([
      kdb
        .selectFrom("quota_consumption")
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("consumed"), eb.val(0)).as("total"))
        .where("dimension_key", "=", dimensionKey)
        .where("bucket_index", "=", currentBucket)
        .executeTakeFirst(),
      kdb
        .selectFrom("quota_consumption")
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("consumed"), eb.val(0)).as("total"))
        .where("dimension_key", "=", dimensionKey)
        .where("bucket_index", "=", prevBucket)
        .executeTakeFirst(),
    ]);
    return {
      currTotal: toNumber(currRow?.total, 0),
      prevTotal: toNumber(prevRow?.total, 0),
    };
  }

  interface SumRow {
    total: number;
  }

  const currRow = getDb()
    .prepare<SumRow>(
      `SELECT COALESCE(SUM(consumed), 0) AS total
       FROM quota_consumption
       WHERE dimension_key = ? AND bucket_index = ?`
    )
    .get(dimensionKey, currentBucket);

  const prevRow = getDb()
    .prepare<SumRow>(
      `SELECT COALESCE(SUM(consumed), 0) AS total
       FROM quota_consumption
       WHERE dimension_key = ? AND bucket_index = ?`
    )
    .get(dimensionKey, prevBucket);

  return {
    currTotal: currRow?.total ?? 0,
    prevTotal: prevRow?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

/**
 * Delete rows whose updated_at is strictly less than maxUpdatedAtMs.
 * Used by GC background job to clean up stale bucket rows.
 *
 * Boundary semantics: rows with updated_at === maxUpdatedAtMs are KEPT.
 * Only rows with updated_at < maxUpdatedAtMs (strictly older) are deleted.
 *
 * @param maxUpdatedAtMs Epoch ms threshold (exclusive lower bound for kept rows).
 * @returns              Number of rows deleted.
 */
export async function gcOlderThan(maxUpdatedAtMs: number): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("quota_consumption")
      .where("updated_at", "<", maxUpdatedAtMs)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  const result = getDb()
    .prepare("DELETE FROM quota_consumption WHERE updated_at < ?")
    .run(maxUpdatedAtMs);
  return result.changes;
}
