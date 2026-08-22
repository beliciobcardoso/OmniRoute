import test from "node:test";
import assert from "node:assert/strict";

import {
  saveQuotaSnapshot,
  getQuotaSnapshots,
  getAggregatedSnapshots,
  cleanupOldSnapshots,
} from "../../../src/lib/db/quotaSnapshots";
import {
  ensurePostgresBootstrap,
  resetKyselyDb,
  getKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "quotaSnapshots (postgres) save/query/aggregate/cleanup lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      await saveQuotaSnapshot({
        provider: "openai-pg",
        connection_id: "pg-conn-1",
        window_key: "hourly",
        remaining_percentage: 60,
        is_exhausted: 0,
        next_reset_at: "2026-01-01T01:00:00.000Z",
        window_duration_ms: 3600000,
        raw_data: null,
      });
      await saveQuotaSnapshot({
        provider: "openai-pg",
        connection_id: "pg-conn-1",
        window_key: "hourly",
        remaining_percentage: 20,
        is_exhausted: 1,
        next_reset_at: "2026-01-01T01:00:00.000Z",
        window_duration_ms: 3600000,
        raw_data: null,
      });

      const rows = await getQuotaSnapshots({
        provider: "openai-pg",
        connectionId: "pg-conn-1",
        since: "2000-01-01T00:00:00.000Z",
      });
      assert.equal(rows.length, 2);

      const agg = await getAggregatedSnapshots({
        provider: "openai-pg",
        since: "2000-01-01T00:00:00.000Z",
        bucketMinutes: 60,
      });
      assert.equal(agg.length, 1);
      assert.equal(agg[0].isExhausted, true);

      const kdb = getKyselyDb();
      await kdb
        .insertInto("quota_snapshots")
        .values({
          provider: "openai-pg",
          connection_id: "pg-conn-old",
          window_key: "hourly",
          remaining_percentage: 10,
          is_exhausted: 1,
          next_reset_at: null,
          window_duration_ms: null,
          raw_data: null,
          created_at: "2000-01-01T00:00:00.000Z",
        })
        .execute();

      const deleted = await cleanupOldSnapshots(1);
      assert.ok(deleted >= 1);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("quota_snapshots")
        .where("provider", "=", "openai-pg")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
