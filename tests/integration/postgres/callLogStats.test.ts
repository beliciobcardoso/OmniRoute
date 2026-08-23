import test from "node:test";
import assert from "node:assert/strict";

import {
  getProviderMetrics,
  getSearchProviderStats,
  getRecentSearchLogs,
  getSearchAggregateStats,
  getSearchProviderCounts,
  getFallbackStats,
} from "../../../src/lib/db/callLogStats";
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
  "callLogStats (postgres) provider-metrics/search-stats aggregation lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const nowIso = new Date().toISOString();
    const kdb = getKyselyDb();

    const baseRow = {
      timestamp: nowIso,
      method: "POST",
      path: "/v1/chat/completions",
      duration: 120,
    };

    try {
      await kdb
        .insertInto("call_logs")
        .values([
          {
            ...baseRow,
            id: "pg-cls-1",
            provider: "pg-openai",
            status: 200,
            request_type: "chat",
          },
          {
            ...baseRow,
            id: "pg-cls-2",
            provider: "pg-openai",
            status: 500,
            error_summary: "boom",
            request_type: "chat",
          },
          {
            ...baseRow,
            id: "pg-cls-3",
            provider: "pg-openai",
            status: 200,
            request_type: "search",
            request_summary: "search summary",
            duration: 3,
          },
          {
            ...baseRow,
            id: "pg-cls-fb-1",
            provider: "pg-fallback-test",
            status: 200,
            request_type: "chat",
            combo_name: null,
            requested_model: "openai/gpt-4",
            model: "gpt-4",
          },
          {
            ...baseRow,
            id: "pg-cls-fb-2",
            provider: "pg-fallback-test",
            status: 200,
            request_type: "chat",
            combo_name: null,
            requested_model: "openai/gpt-4",
            model: "gpt-4o",
          },
          {
            ...baseRow,
            id: "pg-cls-fb-3",
            provider: "pg-fallback-test",
            status: 200,
            request_type: "chat",
            combo_name: "my-combo",
            requested_model: "openai/gpt-4",
            model: "gpt-4o",
          },
        ])
        .execute();

      const providerMetrics = await getProviderMetrics();
      const openaiMetric = providerMetrics.find((m) => m.provider === "pg-openai");
      assert.ok(openaiMetric);
      assert.equal(openaiMetric.totalRequests, 3);
      assert.equal(openaiMetric.totalSuccesses, 2);

      const searchStats = await getSearchProviderStats();
      const openaiSearch = searchStats.find((s) => s.provider === "pg-openai");
      assert.ok(openaiSearch);
      assert.equal(openaiSearch.requests, 1);

      const recent = await getRecentSearchLogs();
      assert.ok(recent.some((r) => r.request_summary === "search summary"));

      const todayIso = new Date(Date.now() - 86_400_000).toISOString();
      const aggregate = await getSearchAggregateStats(todayIso);
      assert.ok(aggregate.total >= 1);
      assert.ok(aggregate.cached >= 1, "duration<5 rows count as cached");

      const counts = await getSearchProviderCounts();
      assert.ok(counts.some((c) => c.provider === "pg-openai" && c.cnt >= 1));

      const fallbackStats = await getFallbackStats("WHERE provider = @provider", {
        provider: "pg-fallback-test",
      });
      assert.equal(Number(fallbackStats.total), 2);
      assert.equal(Number(fallbackStats.with_requested), 2);
      assert.equal(Number(fallbackStats.fallback_eligible), 2);
      assert.equal(Number(fallbackStats.fallbacks), 1);
    } finally {
      await kdb
        .deleteFrom("call_logs")
        .where("provider", "in", ["pg-openai", "pg-fallback-test"])
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
