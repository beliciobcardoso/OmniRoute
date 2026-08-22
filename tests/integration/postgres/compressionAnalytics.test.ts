import test from "node:test";
import assert from "node:assert/strict";

import {
  insertCompressionAnalyticsRow,
  insertCompressionEngineBreakdown,
  attachCompressionUsageReceipt,
  recordContextEditingTelemetry,
  getPerEngineAnalytics,
  getCompressionAnalyticsSummary,
  getLatestCompressionAnalyticsRun,
} from "../../../src/lib/db/compressionAnalytics";
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
  "compressionAnalytics (postgres) insert/breakdown/receipt/summary lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();
    const requestId = "pg-analytics-req-1";

    try {
      await insertCompressionAnalyticsRow({
        timestamp: new Date().toISOString(),
        provider: "pg-openai",
        mode: "stacked",
        engine: "rtk",
        original_tokens: 1000,
        compressed_tokens: 400,
        tokens_saved: 600,
        request_id: requestId,
        compression_combo_id: "pg-combo-1",
      });

      await insertCompressionEngineBreakdown([
        {
          timestamp: new Date().toISOString(),
          request_id: requestId,
          engine: "rtk",
          original_tokens: 1000,
          compressed_tokens: 700,
          tokens_saved: 300,
        },
        {
          timestamp: new Date().toISOString(),
          request_id: requestId,
          engine: "caveman",
          original_tokens: 700,
          compressed_tokens: 400,
          tokens_saved: 300,
        },
      ]);

      await attachCompressionUsageReceipt(
        requestId,
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        "provider"
      );

      await recordContextEditingTelemetry(
        "pg-analytics-req-ctx",
        { clearedInputTokens: 250, clearedToolUses: 2, editCount: 1 },
        "claude"
      );

      const latest = await getLatestCompressionAnalyticsRun();
      assert.ok(latest);

      const perEngine = await getPerEngineAnalytics("rtk", 7);
      assert.ok(perEngine.runs >= 1);
      assert.ok(perEngine.tokensSaved >= 300);

      const summary = await getCompressionAnalyticsSummary();
      assert.ok(summary.totalRequests >= 1);
      assert.ok(summary.byProvider["pg-openai"]);
      assert.ok(summary.byCompressionCombo["pg-combo-1"]);
      assert.equal(summary.realUsage.requestsWithReceipts, 1);
      assert.equal(summary.realUsage.promptTokens, 10);
      assert.ok(summary.byMode["context-editing"]);

      const summary24h = await getCompressionAnalyticsSummary("24h");
      assert.ok(summary24h.totalRequests >= 1);
      assert.ok(Array.isArray(summary24h.last24h));
      assert.equal(summary24h.last24h.length, 24);
    } finally {
      await kdb
        .deleteFrom("compression_engine_breakdown")
        .where("request_id", "=", requestId)
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("compression_analytics")
        .where("request_id", "like", "pg-analytics-req%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
