import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanupQuotaSnapshots,
  cleanupCallLogs,
  cleanupCompressionAnalytics,
  cleanupMcpAudit,
  cleanupA2aEvents,
  cleanupMemoryEntries,
  cleanupProxyLogs,
  purgeQuotaSnapshots,
  purgeDetailedLogs,
  resetUsageHistory,
} from "../../../src/lib/db/cleanup";
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
  "cleanup (postgres) retention-based deletes + resetUsageHistory",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();
    const oldIso = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();

    try {
      await kdb
        .insertInto("quota_snapshots")
        .values({
          provider: "pg-cleanup",
          connection_id: "pg-cleanup-conn",
          window_key: "daily",
          created_at: oldIso,
        })
        .execute();
      const quotaResult = await cleanupQuotaSnapshots();
      assert.equal(quotaResult.errors, 0);
      assert.ok(quotaResult.deleted >= 1);

      await kdb
        .insertInto("call_logs")
        .values({
          id: "pg-cleanup-cl-1",
          timestamp: oldIso,
          method: "POST",
          path: "/v1/chat/completions",
          duration: 10,
          provider: "pg-cleanup",
        })
        .execute();
      const callLogsResult = await cleanupCallLogs();
      assert.equal(callLogsResult.errors, 0);
      assert.ok(callLogsResult.deleted >= 1);

      await kdb
        .insertInto("compression_analytics")
        .values({
          timestamp: oldIso,
          mode: "test",
          original_tokens: 100,
          compressed_tokens: 50,
          tokens_saved: 50,
        })
        .execute();
      const compressionResult = await cleanupCompressionAnalytics();
      assert.equal(compressionResult.errors, 0);
      assert.ok(compressionResult.deleted >= 1);

      // Regression guard for the created_at (not timestamp) column bug.
      await kdb
        .insertInto("mcp_tool_audit")
        .values({ tool_name: "pg-cleanup-tool", created_at: oldIso })
        .execute();
      const mcpResult = await cleanupMcpAudit();
      assert.equal(mcpResult.errors, 0);
      assert.ok(mcpResult.deleted >= 1);

      await kdb
        .insertInto("a2a_task_events")
        .values({ task_id: "pg-cleanup-task-1", event_type: "created", created_at: oldIso })
        .execute();
      const a2aResult = await cleanupA2aEvents();
      assert.equal(a2aResult.errors, 0);
      assert.ok(a2aResult.deleted >= 1);

      await kdb
        .insertInto("memories")
        .values({
          id: "pg-cleanup-mem-1",
          api_key_id: "pg-cleanup-key",
          type: "note",
          content: "old memory",
          created_at: oldIso,
          updated_at: oldIso,
        })
        .execute();
      const memoryResult = await cleanupMemoryEntries();
      assert.equal(memoryResult.errors, 0);
      assert.ok(memoryResult.deleted >= 1);

      await kdb
        .insertInto("proxy_logs")
        .values({ id: "pg-cleanup-pl-1", timestamp: oldIso })
        .execute();
      const proxyLogsResult = await cleanupProxyLogs();
      assert.equal(proxyLogsResult.errors, 0);
      assert.ok(proxyLogsResult.deleted >= 1);

      await kdb
        .insertInto("quota_snapshots")
        .values({
          provider: "pg-cleanup-purge",
          connection_id: "pg-cleanup-purge-conn",
          window_key: "daily",
        })
        .execute();
      const purgedQuota = await purgeQuotaSnapshots();
      assert.equal(purgedQuota.errors, 0);
      assert.ok(purgedQuota.deleted >= 1);

      await kdb
        .insertInto("request_detail_logs")
        .values({ id: "pg-cleanup-rdl-1", timestamp: oldIso })
        .execute();
      const purgedDetailed = await purgeDetailedLogs();
      assert.equal(purgedDetailed.errors, 0);
      assert.ok(purgedDetailed.deleted >= 1);

      await kdb
        .insertInto("usage_history")
        .values({
          timestamp: oldIso,
          provider: "pg-cleanup-reset",
          model: "gpt-4",
          tokens_input: 1,
          tokens_output: 1,
          success: 1,
          connection_id: "pg-cleanup-reset-conn",
        })
        .execute();
      await kdb
        .insertInto("daily_usage_summary")
        .values({ provider: "pg-cleanup-reset", model: "gpt-4", date: oldIso.slice(0, 10) })
        .execute();
      await kdb
        .insertInto("hourly_usage_summary")
        .values({
          provider: "pg-cleanup-reset",
          model: "gpt-4",
          date_hour: `${oldIso.slice(0, 10)} 00:00:00`,
        })
        .execute();

      const resetResult = await resetUsageHistory("30d");
      assert.equal(resetResult.errors, 0);
      assert.equal(resetResult.deletedUsageHistory, 1);
      assert.equal(resetResult.deletedDailySummary, 1);
      assert.equal(resetResult.deletedHourlySummary, 1);
    } finally {
      await kdb
        .deleteFrom("quota_snapshots")
        .where("provider", "in", ["pg-cleanup", "pg-cleanup-purge"])
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("call_logs")
        .where("id", "=", "pg-cleanup-cl-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("mcp_tool_audit")
        .where("tool_name", "=", "pg-cleanup-tool")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("a2a_task_events")
        .where("task_id", "=", "pg-cleanup-task-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("memories")
        .where("id", "=", "pg-cleanup-mem-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("proxy_logs")
        .where("id", "=", "pg-cleanup-pl-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("request_detail_logs")
        .where("id", "=", "pg-cleanup-rdl-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("usage_history")
        .where("provider", "=", "pg-cleanup-reset")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("daily_usage_summary")
        .where("provider", "=", "pg-cleanup-reset")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("hourly_usage_summary")
        .where("provider", "=", "pg-cleanup-reset")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
