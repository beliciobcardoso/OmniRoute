import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Aggregation queries over `call_logs` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/provider-metrics, /api/search/stats, and /api/v1/search/analytics routes
 * can delegate. Read-only aggregation; no writes.
 *
 * Sliced out of #3500 (call_logs cluster).
 *
 * getFallbackStats stays SQLite-only/synchronous: it shares the dynamic
 * whereClause/named-@param convention used throughout the much larger
 * usageAnalytics.ts query cluster (also not yet converted), and the two need
 * a single, consistent WHERE-clause translation strategy for Postgres rather
 * than two independent ad-hoc ones. Deferred to when usageAnalytics.ts is
 * converted.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderMetricRow {
  provider: string;
  totalRequests: number;
  totalSuccesses: number;
  avgLatencyMs: number;
  lastRequestAt: string | null;
  lastErrorAt: string | null;
  lastStatus: number | null;
  lastErrorStatus: number | null;
}

export interface SearchProviderStatRow {
  provider: string;
  requests: number;
  avg_latency_ms: number;
}

export interface SearchRecentRow {
  request_summary: string | null;
  provider: string;
  timestamp: string;
}

export interface SearchAggregateStats {
  total: number;
  today: number;
  errors: number;
  avg_duration: number | null;
  cached: number;
}

export interface SearchProviderCountRow {
  provider: string;
  cnt: number;
}

// ---------------------------------------------------------------------------
// /api/provider-metrics — per-provider success/latency/error aggregates
// ---------------------------------------------------------------------------

/**
 * Per-provider request metrics: totals, success count, avg latency, and the
 * most recent request/error status+timestamp (via correlated subqueries).
 */
export async function getProviderMetrics(): Promise<ProviderMetricRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const { sql } = await import("kysely");
    const result = await sql<{
      provider: string;
      totalRequests: number | string;
      totalSuccesses: number | string;
      avgLatencyMs: number | string | null;
      lastRequestAt: string | null;
      lastErrorAt: string | null;
      lastStatus: number | null;
      lastErrorStatus: number | null;
    }>`
      SELECT
        c.provider,
        COUNT(*) as "totalRequests",
        SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as "totalSuccesses",
        ROUND(AVG(duration)) as "avgLatencyMs",
        MAX(timestamp) as "lastRequestAt",
        MAX(
          CASE
            WHEN (status IS NOT NULL AND (status < 200 OR status >= 400))
              OR error_summary IS NOT NULL
            THEN timestamp
            ELSE NULL
          END
        ) as "lastErrorAt",
        (
          SELECT c2.status
          FROM call_logs c2
          WHERE c2.provider = c.provider
          ORDER BY c2.timestamp DESC, c2.id DESC
          LIMIT 1
        ) as "lastStatus",
        (
          SELECT c3.status
          FROM call_logs c3
          WHERE c3.provider = c.provider
            AND (
              (c3.status IS NOT NULL AND (c3.status < 200 OR c3.status >= 400))
              OR c3.error_summary IS NOT NULL
            )
          ORDER BY c3.timestamp DESC, c3.id DESC
          LIMIT 1
        ) as "lastErrorStatus"
      FROM call_logs c
      WHERE c.provider IS NOT NULL AND c.provider != '-'
      GROUP BY c.provider
    `.execute(kdb);

    return result.rows.map((r) => ({
      provider: r.provider,
      totalRequests: toNum(r.totalRequests),
      totalSuccesses: toNum(r.totalSuccesses),
      avgLatencyMs: toNum(r.avgLatencyMs),
      lastRequestAt: r.lastRequestAt,
      lastErrorAt: r.lastErrorAt,
      lastStatus: r.lastStatus,
      lastErrorStatus: r.lastErrorStatus,
    }));
  }

  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
          c.provider,
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as totalSuccesses,
          ROUND(AVG(duration)) as avgLatencyMs,
          MAX(timestamp) as lastRequestAt,
          MAX(
            CASE
              WHEN (status IS NOT NULL AND (status < 200 OR status >= 400))
                OR error_summary IS NOT NULL
              THEN timestamp
              ELSE NULL
            END
          ) as lastErrorAt,
          (
            SELECT c2.status
            FROM call_logs c2
            WHERE c2.provider = c.provider
            ORDER BY c2.timestamp DESC, c2.id DESC
            LIMIT 1
          ) as lastStatus,
          (
            SELECT c3.status
            FROM call_logs c3
            WHERE c3.provider = c.provider
              AND (
                (c3.status IS NOT NULL AND (c3.status < 200 OR c3.status >= 400))
                OR c3.error_summary IS NOT NULL
              )
            ORDER BY c3.timestamp DESC, c3.id DESC
            LIMIT 1
          ) as lastErrorStatus
        FROM call_logs c
        WHERE c.provider IS NOT NULL AND c.provider != '-'
        GROUP BY c.provider`
    )
    .all() as ProviderMetricRow[];
}

// ---------------------------------------------------------------------------
// /api/search/stats — search provider aggregates + recent entries
// ---------------------------------------------------------------------------

/**
 * Per-provider request count and average latency for search requests.
 */
export async function getSearchProviderStats(): Promise<SearchProviderStatRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("call_logs")
      .select((eb) => [
        "provider",
        eb.fn.countAll().as("requests"),
        eb.fn<number>("round", [eb.fn.avg("duration")]).as("avg_latency_ms"),
      ])
      .where("request_type", "=", "search")
      .groupBy("provider")
      .execute();
    return rows.map((r) => ({
      provider: String(r.provider),
      requests: toNum(r.requests),
      avg_latency_ms: toNum(r.avg_latency_ms),
    }));
  }

  const db = getDbInstance();
  return db
    .prepare(
      `
        SELECT provider, COUNT(*) as requests,
          CAST(AVG(duration) AS INTEGER) as avg_latency_ms
        FROM call_logs
        WHERE request_type = 'search'
        GROUP BY provider
      `
    )
    .all() as SearchProviderStatRow[];
}

/**
 * Most recent 10 search entries (request_summary + provider + timestamp).
 */
export async function getRecentSearchLogs(): Promise<SearchRecentRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("call_logs")
      .select(["request_summary", "provider", "timestamp"])
      .where("request_type", "=", "search")
      .orderBy("timestamp", "desc")
      .limit(10)
      .execute();
    return rows.map((r) => ({
      request_summary: r.request_summary,
      provider: r.provider ?? "",
      timestamp: r.timestamp ?? "",
    }));
  }

  const db = getDbInstance();
  return db
    .prepare(
      `
        SELECT request_summary, provider, timestamp
        FROM call_logs
        WHERE request_type = 'search'
        ORDER BY timestamp DESC
        LIMIT 10
      `
    )
    .all() as SearchRecentRow[];
}

// ---------------------------------------------------------------------------
// /api/v1/search/analytics — aggregated search analytics
// ---------------------------------------------------------------------------

/**
 * Single-pass scalar aggregations for all search entries since `todayIso`.
 * `todayIso` is the ISO-8601 UTC start-of-day string used for the "today" count.
 */
export async function getSearchAggregateStats(todayIso: string): Promise<SearchAggregateStats> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const { sql } = await import("kysely");
    const result = await sql<{
      total: number | string;
      today: number | string;
      errors: number | string;
      avg_duration: number | string | null;
      cached: number | string;
    }>`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN timestamp >= ${todayIso} THEN 1 ELSE 0 END), 0) as today,
        COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN 1 ELSE 0 END), 0) as errors,
        AVG(CASE WHEN duration > 0 THEN duration END) as avg_duration,
        COALESCE(SUM(CASE WHEN duration > 0 AND duration < 5 THEN 1 ELSE 0 END), 0) as cached
      FROM call_logs
      WHERE request_type = 'search'
    `.execute(kdb);
    const row = result.rows[0];
    if (!row) return { total: 0, today: 0, errors: 0, avg_duration: null, cached: 0 };
    return {
      total: toNum(row.total),
      today: toNum(row.today),
      errors: toNum(row.errors),
      avg_duration: row.avg_duration === null ? null : toNum(row.avg_duration),
      cached: toNum(row.cached),
    };
  }

  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END), 0) as today,
          COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN 1 ELSE 0 END), 0) as errors,
          AVG(CASE WHEN duration > 0 THEN duration END) as avg_duration,
          COALESCE(SUM(CASE WHEN duration > 0 AND duration < 5 THEN 1 ELSE 0 END), 0) as cached
         FROM call_logs
         WHERE request_type = 'search'`
    )
    .get(todayIso) as SearchAggregateStats | undefined;
  return row ?? { total: 0, today: 0, errors: 0, avg_duration: null, cached: 0 };
}

/**
 * Per-provider request count for search entries, ordered by count descending.
 */
export async function getSearchProviderCounts(): Promise<SearchProviderCountRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("call_logs")
      .select((eb) => ["provider", eb.fn.countAll().as("cnt")])
      .where("request_type", "=", "search")
      .groupBy("provider")
      .orderBy("cnt", "desc")
      .execute();
    return rows.map((r) => ({ provider: String(r.provider), cnt: toNum(r.cnt) }));
  }

  const db = getDbInstance();
  return db
    .prepare(
      `SELECT provider, COUNT(*) as cnt
         FROM call_logs WHERE request_type = 'search'
         GROUP BY provider ORDER BY cnt DESC`
    )
    .all() as SearchProviderCountRow[];
}

// ---------------------------------------------------------------------------
// /api/usage/analytics — fallback-rate aggregates over call_logs
// ---------------------------------------------------------------------------

export interface FallbackStatsRow {
  total: number;
  with_requested: number;
  fallback_eligible: number;
  fallbacks: number;
}

/**
 * Scalar fallback-rate stats over `call_logs` for the usage analytics endpoint.
 *
 * SQLite-only — see module docstring (shares usageAnalytics.ts's dynamic
 * whereClause/@param convention, deferred to that module's conversion).
 *
 * @param whereClause - SQL WHERE clause (may be empty string) using the same
 *                      named params as the usage_history queries.
 * @param params      - Named params object (string values).
 */
export function getFallbackStats(
  whereClause: string,
  params: Record<string, string>
): FallbackStatsRow {
  const db = getDbInstance();
  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as total,
        SUM(CASE WHEN requested_model IS NOT NULL AND requested_model != '' AND (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as with_requested,
        SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
          THEN 1 ELSE 0 END
        ) as fallback_eligible,
        SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
           AND LOWER(CASE WHEN instr(requested_model, '/') > 0 THEN substr(requested_model, instr(requested_model, '/') + 1) ELSE requested_model END) != LOWER(model)
          THEN 1 ELSE 0 END
        ) as fallbacks
      FROM call_logs
      ${whereClause}
    `
    )
    .get(params) as FallbackStatsRow | undefined;
  return row ?? { total: 0, with_requested: 0, fallback_eligible: 0, fallbacks: 0 };
}
