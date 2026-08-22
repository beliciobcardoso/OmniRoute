import { getDbInstance, rowToCamel } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";
import type { QuotaSnapshotRow, ProviderUtilizationPoint } from "@/shared/types/utilization";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

let lastCleanupAt = 0;

export async function saveQuotaSnapshot(
  snapshot: Omit<QuotaSnapshotRow, "id" | "created_at">
): Promise<void> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("quota_snapshots")
      .values({
        provider: snapshot.provider,
        connection_id: snapshot.connection_id,
        window_key: snapshot.window_key,
        remaining_percentage: snapshot.remaining_percentage,
        is_exhausted: snapshot.is_exhausted,
        next_reset_at: snapshot.next_reset_at,
        window_duration_ms: snapshot.window_duration_ms,
        raw_data: snapshot.raw_data,
        created_at: now,
      })
      .execute();
    return;
  }

  const db = getDbInstance() as unknown as DbLike;

  try {
    db.prepare(
      `INSERT INTO quota_snapshots
       (provider, connection_id, window_key, remaining_percentage, is_exhausted,
        next_reset_at, window_duration_ms, raw_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      snapshot.provider,
      snapshot.connection_id,
      snapshot.window_key,
      snapshot.remaining_percentage,
      snapshot.is_exhausted,
      snapshot.next_reset_at,
      snapshot.window_duration_ms,
      snapshot.raw_data,
      now
    );
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      console.warn(
        "[QuotaSnapshots] Skipping save: quota_snapshots table not found. Awaiting migration."
      );
      return;
    }
    throw err;
  }
}

export async function getQuotaSnapshots(opts: {
  provider?: string;
  connectionId?: string;
  since: string;
  until?: string;
}): Promise<QuotaSnapshotRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    let query = kdb.selectFrom("quota_snapshots").selectAll().where("created_at", ">=", opts.since);
    if (opts.provider) query = query.where("provider", "=", opts.provider);
    if (opts.connectionId) query = query.where("connection_id", "=", opts.connectionId);
    if (opts.until) query = query.where("created_at", "<=", opts.until);
    const rows = await query.orderBy("created_at", "asc").execute();
    return rows.map((r) => rowToCamel(r) as unknown as QuotaSnapshotRow);
  }

  const db = getDbInstance() as unknown as DbLike;
  const conditions: string[] = ["created_at >= ?"];
  const params: unknown[] = [opts.since];

  if (opts.provider) {
    conditions.push("provider = ?");
    params.push(opts.provider);
  }

  if (opts.connectionId) {
    conditions.push("connection_id = ?");
    params.push(opts.connectionId);
  }

  if (opts.until) {
    conditions.push("created_at <= ?");
    params.push(opts.until);
  }

  try {
    const sql = `SELECT * FROM quota_snapshots WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`;
    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => rowToCamel(r) as unknown as QuotaSnapshotRow);
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

/**
 * Hot-path read used by src/domain/quotaCache.ts to rehydrate the in-memory
 * cache on a miss. Stays SQLite-only (out of scope this session, same
 * coupling as proxies.ts/contextHandoffs.ts): the caller is fully synchronous
 * on purpose to avoid rippling async through the request-routing hot path.
 * See docs/architecture/POSTGRES_SUPPORT.md.
 */
export function getLatestQuotaSnapshotsForConnection(connectionId: string): QuotaSnapshotRow[] {
  const db = getDbInstance() as unknown as DbLike;

  try {
    const rows = db
      .prepare(
        `SELECT * FROM quota_snapshots
         WHERE connection_id = ?
         ORDER BY created_at DESC
         LIMIT 200`
      )
      .all(connectionId);
    const latestByWindow = new Map<string, QuotaSnapshotRow>();

    for (const row of rows) {
      const snapshot = rowToCamel(row) as unknown as QuotaSnapshotRow;
      const windowKey =
        (snapshot as unknown as { windowKey?: string }).windowKey ?? snapshot.window_key;
      if (!windowKey || latestByWindow.has(windowKey)) continue;
      latestByWindow.set(windowKey, snapshot);
    }

    return [...latestByWindow.values()];
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export async function getAggregatedSnapshots(opts: {
  provider?: string;
  since: string;
  until?: string;
  bucketMinutes: number;
  aggregateBy?: "provider" | "connection";
}): Promise<ProviderUtilizationPoint[]> {
  const bucketSeconds = Number(opts.bucketMinutes) * 60;
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("Invalid bucket size");
  }

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const { sql } = await import("kysely");

    const conditions = [sql`created_at >= ${opts.since}`];
    if (opts.provider) conditions.push(sql`provider = ${opts.provider}`);
    if (opts.until) conditions.push(sql`created_at <= ${opts.until}`);
    const whereClause = sql.join(conditions, sql` AND `);

    const selectKey =
      opts.aggregateBy === "connection"
        ? sql`provider || ':' || connection_id as provider`
        : sql`provider`;
    const groupByFields =
      opts.aggregateBy === "connection"
        ? sql`bucket, provider, connection_id, window_key`
        : sql`bucket, provider, window_key`;

    const query = sql<{
      bucket: string;
      provider: string;
      remainingPct: number | string | null;
      isExhausted: number | string | null;
      windowKey: string;
    }>`
      SELECT
        to_char(
          to_timestamp(floor(extract(epoch from created_at::timestamptz) / ${bucketSeconds}) * ${bucketSeconds}),
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as bucket,
        ${selectKey},
        AVG(remaining_percentage) as "remainingPct",
        MAX(is_exhausted) as "isExhausted",
        window_key as "windowKey"
      FROM quota_snapshots
      WHERE ${whereClause}
      GROUP BY ${groupByFields}
      ORDER BY bucket ASC
    `;

    const { rows: pgRows } = await query.execute(kdb);

    return pgRows.map((r) => ({
      timestamp: r.bucket,
      provider: r.provider,
      remainingPct: Number(r.remainingPct ?? 0),
      isExhausted: Number(r.isExhausted) === 1,
      windowKey: r.windowKey,
    }));
  }

  const db = getDbInstance() as unknown as DbLike;
  const conditions: string[] = ["created_at >= ?"];
  const params: unknown[] = [opts.since];

  if (opts.provider) {
    conditions.push("provider = ?");
    params.push(opts.provider);
  }

  if (opts.until) {
    conditions.push("created_at <= ?");
    params.push(opts.until);
  }

  const groupFields =
    opts.aggregateBy === "connection"
      ? "bucket, provider, connection_id, window_key"
      : "bucket, provider, window_key";
  const selectKey =
    opts.aggregateBy === "connection" ? "provider || ':' || connection_id as provider" : "provider";

  try {
    const sql = `
      SELECT
        datetime((strftime('%s', created_at) / ${bucketSeconds}) * ${bucketSeconds}, 'unixepoch') as bucket,
        ${selectKey},
        AVG(remaining_percentage) as remainingPct,
        MAX(is_exhausted) as isExhausted,
        window_key
      FROM quota_snapshots
      WHERE ${conditions.join(" AND ")}
      GROUP BY ${groupFields}
      ORDER BY bucket ASC
    `;

    const rows = db.prepare(sql).all(...params) as Array<{
      bucket: string;
      provider: string;
      remainingPct: number | null;
      isExhausted: number;
      windowKey: string;
    }>;

    return rows.map((r) => ({
      timestamp: r.bucket,
      provider: r.provider,
      remainingPct: r.remainingPct ?? 0,
      isExhausted: r.isExhausted === 1,
      windowKey: r.windowKey,
    }));
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export async function cleanupOldSnapshots(retentionDays = 90): Promise<number> {
  const now = Date.now();
  const cleanupThresholdMs = 6 * 60 * 60 * 1000;

  if (now - lastCleanupAt < cleanupThresholdMs) {
    return 0;
  }

  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("quota_snapshots")
      .where("created_at", "<", cutoffDate)
      .executeTakeFirst();
    lastCleanupAt = now;
    return Number(result.numDeletedRows ?? 0);
  }

  const db = getDbInstance() as unknown as DbLike;

  try {
    const result = db.prepare("DELETE FROM quota_snapshots WHERE created_at < ?").run(cutoffDate);
    lastCleanupAt = now;
    return result.changes;
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return 0;
    }
    throw err;
  }
}
