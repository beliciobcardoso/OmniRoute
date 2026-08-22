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

export interface CacheStatsEntry {
  provider: string;
  model?: string;
  compressionMode: string;
  cacheControlPresent: boolean;
  estimatedCacheHit: boolean;
  tokensSavedCompression: number;
  tokensSavedCaching: number;
  netSavings: number;
}

export interface CacheStatsSummary {
  totalRequests: number;
  avgNetSavings: number;
  cacheHitRate: number;
  byProvider: Record<string, { count: number; avgNetSavings: number; cacheHitRate: number }>;
}

export async function recordCacheStats(entry: CacheStatsEntry): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("compression_cache_stats")
      .values({
        provider: entry.provider,
        model: entry.model ?? "",
        compression_mode: entry.compressionMode,
        cache_control_present: entry.cacheControlPresent ? 1 : 0,
        estimated_cache_hit: entry.estimatedCacheHit ? 1 : 0,
        tokens_saved_compression: entry.tokensSavedCompression,
        tokens_saved_caching: entry.tokensSavedCaching,
        net_savings: entry.netSavings,
      })
      .execute();
    return;
  }

  const db = getDbInstance();

  const sql = `INSERT INTO compression_cache_stats (
    provider,
    model,
    compression_mode,
    cache_control_present,
    estimated_cache_hit,
    tokens_saved_compression,
    tokens_saved_caching,
    net_savings
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  db.prepare(sql).run(
    entry.provider,
    entry.model ?? "",
    entry.compressionMode,
    entry.cacheControlPresent ? 1 : 0,
    entry.estimatedCacheHit ? 1 : 0,
    entry.tokensSavedCompression,
    entry.tokensSavedCaching,
    entry.netSavings
  );
}

export async function getCacheStatsSummary(since?: Date): Promise<CacheStatsSummary> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    let globalQuery = kdb
      .selectFrom("compression_cache_stats")
      .select((eb) => [
        eb.fn.countAll().as("totalRequests"),
        eb.fn.avg("net_savings").as("avgNetSavings"),
        eb
          .cast<number>(eb.fn.sum("estimated_cache_hit"), "double precision")
          .as("estimatedCacheHitSum"),
      ]);
    if (since) globalQuery = globalQuery.where("created_at", ">=", since.toISOString());
    const globalRow = await globalQuery.executeTakeFirst();

    const totalRequests = toNum(globalRow?.totalRequests, 0);
    if (!globalRow || totalRequests === 0) {
      return { totalRequests: 0, avgNetSavings: 0, cacheHitRate: 0, byProvider: {} };
    }
    const cacheHitRate = toNum(globalRow.estimatedCacheHitSum) / totalRequests;

    let providerQuery = kdb
      .selectFrom("compression_cache_stats")
      .select((eb) => [
        "provider",
        eb.fn.countAll().as("count"),
        eb.fn.avg("net_savings").as("avgNetSavings"),
        eb
          .cast<number>(eb.fn.sum("estimated_cache_hit"), "double precision")
          .as("estimatedCacheHitSum"),
      ])
      .groupBy("provider");
    if (since) providerQuery = providerQuery.where("created_at", ">=", since.toISOString());
    const providerRows = await providerQuery.execute();

    const byProvider: Record<
      string,
      { count: number; avgNetSavings: number; cacheHitRate: number }
    > = {};
    for (const row of providerRows) {
      const count = toNum(row.count, 0);
      byProvider[String(row.provider)] = {
        count,
        avgNetSavings: toNum(row.avgNetSavings),
        cacheHitRate: count > 0 ? toNum(row.estimatedCacheHitSum) / count : 0,
      };
    }

    return {
      totalRequests,
      avgNetSavings: toNum(globalRow.avgNetSavings),
      cacheHitRate,
      byProvider,
    };
  }

  const db = getDbInstance();

  // Global aggregates
  const globalRow = since
    ? (db
        .prepare(
          `SELECT COUNT(*) as totalRequests, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats WHERE created_at >= ?`
        )
        .get(since.toISOString()) as
        { totalRequests: number; avgNetSavings: number; cacheHitRate: number } | undefined)
    : (db
        .prepare(
          `SELECT COUNT(*) as totalRequests, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats`
        )
        .get() as
        { totalRequests: number; avgNetSavings: number; cacheHitRate: number } | undefined);

  if (!globalRow || globalRow.totalRequests === 0) {
    return { totalRequests: 0, avgNetSavings: 0, cacheHitRate: 0, byProvider: {} };
  }

  // Per-provider aggregates
  const providerRows = since
    ? (db
        .prepare(
          `SELECT provider, COUNT(*) as count, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats WHERE created_at >= ? GROUP BY provider`
        )
        .all(since.toISOString()) as Array<{
        provider: string;
        count: number;
        avgNetSavings: number;
        cacheHitRate: number;
      }>)
    : (db
        .prepare(
          `SELECT provider, COUNT(*) as count, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats GROUP BY provider`
        )
        .all() as Array<{
        provider: string;
        count: number;
        avgNetSavings: number;
        cacheHitRate: number;
      }>);

  const byProvider: Record<string, { count: number; avgNetSavings: number; cacheHitRate: number }> =
    {};
  for (const row of providerRows) {
    byProvider[row.provider] = {
      count: row.count,
      avgNetSavings: row.avgNetSavings,
      cacheHitRate: row.cacheHitRate,
    };
  }

  return {
    totalRequests: globalRow.totalRequests,
    avgNetSavings: globalRow.avgNetSavings ?? 0,
    cacheHitRate: globalRow.cacheHitRate ?? 0,
    byProvider,
  };
}
