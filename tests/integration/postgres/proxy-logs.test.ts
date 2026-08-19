import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import { exportProxyLogsSince } from "../../../src/lib/db/proxyLogs";
import { getKyselyDb, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "exportProxyLogsSince (postgres) returns rows >= since ordered by timestamp desc",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    const db = getKyselyDb();

    try {
      await sql`
        CREATE TABLE IF NOT EXISTS proxy_logs (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          status TEXT,
          proxy_type TEXT,
          proxy_host TEXT,
          proxy_port BIGINT,
          level TEXT,
          level_id TEXT,
          provider TEXT,
          target_url TEXT,
          public_ip TEXT,
          latency_ms BIGINT DEFAULT 0,
          error TEXT,
          connection_id TEXT,
          combo_id TEXT,
          account TEXT,
          tls_fingerprint BIGINT DEFAULT 0
        )
      `.execute(db);
      await sql`TRUNCATE TABLE proxy_logs`.execute(db);

      await db
        .insertInto("proxy_logs")
        .values([
          {
            id: "pl-new-1",
            timestamp: "2025-01-15T11:00:00.000Z",
            provider: "openai",
            status: "ok",
            proxy_type: "http",
          },
          {
            id: "pl-new-2",
            timestamp: "2025-01-15T12:00:00.000Z",
            provider: "anthropic",
            status: "ok",
            proxy_type: "http",
          },
          {
            id: "pl-old-1",
            timestamp: "2025-01-14T10:00:00.000Z", // outside window
            provider: "openai",
            status: "ok",
            proxy_type: "http",
          },
        ])
        .execute();

      const rows = await exportProxyLogsSince("2025-01-15T10:00:00.000Z");

      assert.ok(Array.isArray(rows), "result is array");
      const ids = rows.map((r) => (r as { id: string }).id);
      assert.ok(ids.includes("pl-new-1"), "pl-new-1 included");
      assert.ok(ids.includes("pl-new-2"), "pl-new-2 included");
      assert.ok(!ids.includes("pl-old-1"), "pl-old-1 excluded (before since)");

      // Verify descending order
      for (let i = 1; i < rows.length; i++) {
        const prev = (rows[i - 1] as { timestamp: string }).timestamp;
        const curr = (rows[i] as { timestamp: string }).timestamp;
        assert.ok(prev >= curr, `row ${i - 1} timestamp (${prev}) >= row ${i} (${curr})`);
      }

      const future = new Date(Date.now() + 86_400_000 * 365).toISOString();
      const empty = await exportProxyLogsSince(future);
      assert.deepEqual(empty, []);
    } finally {
      await sql`DROP TABLE IF EXISTS proxy_logs`.execute(db);
      await resetKyselyDb();
    }
  }
);
