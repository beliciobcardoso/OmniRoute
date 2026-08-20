import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import { exportProxyLogsSince } from "../../../src/lib/db/proxyLogs";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

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
      // Table creation goes through the shared, advisory-lock-protected
      // bootstrap rather than an ad hoc CREATE TABLE here — a second,
      // unprotected DDL statement racing the lock-guarded bootstrap (which
      // other test files in this same directory also call concurrently)
      // can hit a duplicate-key error on Postgres's system catalog.
      await ensurePostgresBootstrap();
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
      // Leave the table in place — other integration test files run
      // concurrently and may depend on it existing (shared bootstrap).
      await sql`TRUNCATE TABLE proxy_logs`.execute(db);
      await resetKyselyDb();
    }
  }
);
