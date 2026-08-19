import { getDbInstance } from "./core.ts";
import type { SqliteAdapter } from "./adapters/types.ts";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

/** Total input+output tokens rolled up in daily_usage_summary for the current calendar month. */
export async function sumUsageTokensThisMonth(db?: SqliteAdapter): Promise<number> {
  if (resolveDbDriverConfig().driver === "postgres") {
    return sumUsageTokensThisMonthPostgres();
  }

  const adapter = db ?? getDbInstance();
  try {
    const row = adapter
      .prepare(
        `SELECT COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS used
         FROM daily_usage_summary
         WHERE date >= strftime('%Y-%m-01','now')`
      )
      .get() as { used: number } | undefined;
    return row?.used ?? 0;
  } catch {
    return 0; // table may not exist yet on a fresh install — treat as 0 used
  }
}

async function sumUsageTokensThisMonthPostgres(): Promise<number> {
  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
  try {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("daily_usage_summary")
      .select((eb) => [
        eb.fn.sum<number | string | null>("total_input_tokens").as("inputSum"),
        eb.fn.sum<number | string | null>("total_output_tokens").as("outputSum"),
      ])
      .where("date", ">=", monthStart)
      .executeTakeFirst();
    return Number(row?.inputSum ?? 0) + Number(row?.outputSum ?? 0);
  } catch {
    return 0; // table may not exist yet on a fresh install — treat as 0 used
  }
}
