/**
 * db/proxyLogs.ts — Read queries over the `proxy_logs` table.
 * Extracted from the /api/logs/export route handler.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/logs/export route can delegate.
 *
 * NOTE: The SELECT * intentionally returns the historical `public_ip` column,
 * NOT `clientIp`. This differs from GET /api/usage/proxy-logs which exposes
 * the value as `clientIp`. Callers of the export endpoint should read
 * `public_ip`. This inconsistency will be resolved in a future DB migration
 * (#2880).
 *
 * Sliced out of #3500 (proxy_logs cluster, slice 4).
 */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns all proxy_logs rows with timestamp >= `since`, ordered by timestamp
 * descending (most recent first).
 *
 * @param since - ISO-8601 timestamp lower bound, e.g. "2024-01-01T00:00:00.000Z".
 */
export async function exportProxyLogsSince(since: string): Promise<Record<string, unknown>[]> {
  if (resolveDbDriverConfig().driver === "postgres") {
    return exportProxyLogsSincePostgres(since);
  }

  const db = getDbInstance();
  const stmt = db.prepare(
    "SELECT * FROM proxy_logs WHERE timestamp >= @since ORDER BY timestamp DESC"
  );
  return stmt.all({ since }) as Record<string, unknown>[];
}

async function exportProxyLogsSincePostgres(since: string): Promise<Record<string, unknown>[]> {
  await ensurePostgresBootstrap();
  const rows = await getKyselyDb()
    .selectFrom("proxy_logs")
    .selectAll()
    .where("timestamp", ">=", since)
    .orderBy("timestamp", "desc")
    .execute();
  return rows as Record<string, unknown>[];
}
