import test from "node:test";
import assert from "node:assert/strict";

import {
  rollupDailyUsage,
  rollupHourlyQuota,
  rollupUsageHistoryBeforeDate,
} from "../../../src/lib/usage/aggregateHistory";
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
  "aggregateHistory (postgres) rollupDailyUsage/rollupHourlyQuota/rollupUsageHistoryBeforeDate",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();

    try {
      await kdb
        .insertInto("quota_snapshots")
        .values([
          {
            provider: "pg-agg-openai",
            connection_id: "pg-agg-conn-1",
            window_key: "daily",
            raw_data: JSON.stringify({
              model: "gpt-test",
              input_tokens: 20,
              output_tokens: 6,
              cost: 0.5,
            }),
            created_at: "2026-05-01 10:45:00",
          },
          {
            provider: "pg-agg-openai",
            connection_id: "pg-agg-conn-1",
            window_key: "daily",
            raw_data: JSON.stringify({
              model: "gpt-test",
              input_tokens: 10,
              output_tokens: 4,
              cost: 0.25,
            }),
            created_at: "2026-05-01 10:45:00",
          },
        ])
        .execute();

      // Upserts must replace recomputed totals, not add them twice.
      await rollupDailyUsage("2026-05-01", "2026-05-01");
      await rollupDailyUsage("2026-05-01", "2026-05-01");
      await rollupHourlyQuota("2026-05-01 10:00:00", "2026-05-01 10:59:59");
      await rollupHourlyQuota("2026-05-01 10:00:00", "2026-05-01 10:59:59");

      const daily = await kdb
        .selectFrom("daily_usage_summary")
        .selectAll()
        .where("provider", "=", "pg-agg-openai")
        .executeTakeFirst();
      assert.ok(daily);
      assert.equal(Number(daily.total_requests), 2);
      assert.equal(Number(daily.total_input_tokens), 30);
      assert.equal(Number(daily.total_output_tokens), 10);
      assert.equal(Number(daily.total_cost), 0.75);

      const hourly = await kdb
        .selectFrom("hourly_usage_summary")
        .selectAll()
        .where("provider", "=", "pg-agg-openai")
        .executeTakeFirst();
      assert.ok(hourly);
      assert.equal(Number(hourly.total_requests), 2);
      assert.equal(Number(hourly.total_input_tokens), 30);
      assert.equal(Number(hourly.total_output_tokens), 10);
      assert.equal(Number(hourly.total_cost), 0.75);
      assert.equal(hourly.date_hour, "2026-05-01 10:00:00");

      // rollupUsageHistoryBeforeDate: additive-safe rollup from usage_history,
      // sourced independently from quota_snapshots-based rollupDailyUsage above.
      await kdb
        .insertInto("usage_history")
        .values({
          timestamp: "2026-04-01T12:00:00.000Z",
          provider: "PgAgg-Anthropic",
          model: "Claude-X",
          tokens_input: 15,
          tokens_output: 5,
          success: 1,
          connection_id: "pg-agg-conn-2",
        })
        .execute();

      const rollup = await rollupUsageHistoryBeforeDate("2026-04-02");
      assert.equal(rollup.errors, 0);
      assert.ok(rollup.inserted >= 1);

      const usageHistoryDaily = await kdb
        .selectFrom("daily_usage_summary")
        .selectAll()
        .where("provider", "=", "pgagg-anthropic")
        .executeTakeFirst();
      assert.ok(usageHistoryDaily);
      assert.equal(usageHistoryDaily.model, "claude-x");
      assert.equal(Number(usageHistoryDaily.total_requests), 1);
      assert.equal(Number(usageHistoryDaily.total_input_tokens), 15);
      assert.equal(Number(usageHistoryDaily.total_output_tokens), 5);
    } finally {
      await kdb
        .deleteFrom("quota_snapshots")
        .where("provider", "=", "pg-agg-openai")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("daily_usage_summary")
        .where("provider", "in", ["pg-agg-openai", "pgagg-anthropic"])
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("hourly_usage_summary")
        .where("provider", "=", "pg-agg-openai")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("usage_history")
        .where("provider", "=", "PgAgg-Anthropic")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
