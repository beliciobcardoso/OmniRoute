import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";
import { sql } from "kysely";

/**
 * Provider/model call statistics aggregated from `call_logs`.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/provider-stats route can delegate. Read-only aggregation; no writes.
 */

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export interface ProviderCallStat {
  provider: string;
  nodeName: string | null;
  totalRequests: number;
  successfulRequests: number;
  avgLatencyMs: number | null;
  totalTokensIn: number | null;
  totalTokensOut: number | null;
}

export interface ModelCallStat {
  provider: string;
  nodeName: string | null;
  model: string;
  requests: number;
  avgLatencyMs: number | null;
  successfulRequests: number;
}

export async function getProviderCallStats(): Promise<ProviderCallStat[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("call_logs as c")
      .leftJoin("provider_nodes as pn", "pn.id", "c.provider")
      .select((eb) => [
        "c.provider as provider",
        "pn.name as nodeName",
        eb.fn.countAll().as("totalRequests"),
        sql<string>`SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END)`.as(
          "successfulRequests"
        ),
        sql<string | null>`ROUND(AVG(c.duration))`.as("avgLatencyMs"),
        sql<string | null>`SUM(c.tokens_in)`.as("totalTokensIn"),
        sql<string | null>`SUM(c.tokens_out)`.as("totalTokensOut"),
      ])
      .where("c.provider", "is not", null)
      .where("c.provider", "!=", "-")
      .groupBy(["c.provider", "pn.name"])
      .orderBy(sql`"totalRequests" desc`)
      .execute();

    return rows.map((r) => ({
      provider: r.provider as unknown as string,
      nodeName: (r.nodeName as unknown as string | null) ?? null,
      totalRequests: Number(r.totalRequests),
      successfulRequests: Number(r.successfulRequests),
      avgLatencyMs: r.avgLatencyMs === null ? null : Number(r.avgLatencyMs),
      totalTokensIn: r.totalTokensIn === null ? null : Number(r.totalTokensIn),
      totalTokensOut: r.totalTokensOut === null ? null : Number(r.totalTokensOut),
    }));
  }

  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
         c.provider,
         pn.name AS nodeName,
         COUNT(*) AS totalRequests,
         SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) AS successfulRequests,
         ROUND(AVG(c.duration)) AS avgLatencyMs,
         SUM(c.tokens_in) AS totalTokensIn,
         SUM(c.tokens_out) AS totalTokensOut
       FROM call_logs c
       LEFT JOIN provider_nodes pn ON pn.id = c.provider
       WHERE c.provider IS NOT NULL AND c.provider != '-'
       GROUP BY c.provider
       ORDER BY totalRequests DESC`
    )
    .all() as ProviderCallStat[];
}

export async function getModelCallStats(): Promise<ModelCallStat[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("call_logs as c")
      .leftJoin("provider_nodes as pn", "pn.id", "c.provider")
      .select((eb) => [
        "c.provider as provider",
        "pn.name as nodeName",
        "c.model as model",
        eb.fn.countAll().as("requests"),
        sql<string | null>`ROUND(AVG(c.duration))`.as("avgLatencyMs"),
        sql<string>`SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END)`.as(
          "successfulRequests"
        ),
      ])
      .where("c.provider", "is not", null)
      .where("c.model", "is not", null)
      .groupBy(["c.provider", "pn.name", "c.model"])
      .orderBy("c.provider")
      .orderBy(sql`"requests" desc`)
      .execute();

    return rows.map((r) => ({
      provider: r.provider as unknown as string,
      nodeName: (r.nodeName as unknown as string | null) ?? null,
      model: r.model as unknown as string,
      requests: Number(r.requests),
      avgLatencyMs: r.avgLatencyMs === null ? null : Number(r.avgLatencyMs),
      successfulRequests: Number(r.successfulRequests),
    }));
  }

  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
         c.provider,
         pn.name AS nodeName,
         c.model,
         COUNT(*) AS requests,
         ROUND(AVG(c.duration)) AS avgLatencyMs,
         SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) AS successfulRequests
       FROM call_logs c
       LEFT JOIN provider_nodes pn ON pn.id = c.provider
       WHERE c.provider IS NOT NULL AND c.model IS NOT NULL
       GROUP BY c.provider, c.model
       ORDER BY c.provider, requests DESC`
    )
    .all() as ModelCallStat[];
}
