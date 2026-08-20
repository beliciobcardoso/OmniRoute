import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import {
  recordPluginMetric,
  getPluginMetrics,
  clearPluginMetrics,
} from "../../../src/lib/db/pluginMetrics";
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
  "pluginMetrics (postgres) records, reads, and clears per-(plugin, event) counters",
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
      await sql`TRUNCATE TABLE plugin_metrics`.execute(db);

      await recordPluginMetric("test-plugin", "onRequest", 5.2, false);
      await recordPluginMetric("test-plugin", "onRequest", 3.1, true);

      const metrics = await getPluginMetrics("test-plugin");
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0].calls, 2);
      assert.equal(metrics[0].errors, 1);
      assert.ok(
        metrics[0].totalDurationMs >= 8,
        `expected >= 8, got ${metrics[0].totalDurationMs}`
      );

      await recordPluginMetric("other-plugin", "onResponse", 1, false);
      const all = await getPluginMetrics();
      assert.equal(all.length, 2);

      await clearPluginMetrics("test-plugin");
      const afterClear = await getPluginMetrics("test-plugin");
      assert.equal(afterClear.length, 0);

      const remaining = await getPluginMetrics();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].pluginName, "other-plugin");
    } finally {
      // Leave the table in place — other integration test files run
      // concurrently and may depend on it existing (shared bootstrap).
      await sql`TRUNCATE TABLE plugin_metrics`.execute(db);
      await resetKyselyDb();
    }
  }
);
