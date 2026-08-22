import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUnifiedSource,
  getUsageSummary,
  getDailyUsage,
  getDailyCostRows,
  getHeatmapRows,
  getModelUsageRows,
  getProviderCostRows,
  getProviderUsageRows,
  getAccountCostRows,
  getAccountUsageRows,
  getApiKeyUsageRows,
  getServiceTierUsageRows,
  getApiKeyMetadataRows,
  getWeeklyPatternRows,
  getEndpointUsageRows,
  getProviderDailyUsageRows,
  getAllUsageHistory,
} from "../../../src/lib/db/usageAnalytics";
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
  "usageAnalytics (postgres) unified-source aggregations + endpoint dimension",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();
    const baseTimestamp = new Date();
    const row = (overrides: Record<string, unknown>) => ({
      timestamp: baseTimestamp.toISOString(),
      provider: "PgOpenAI",
      model: "gpt-4.1",
      service_tier: "standard",
      tokens_input: 10,
      tokens_output: 20,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
      tokens_reasoning: 0,
      latency_ms: 100,
      success: 1,
      connection_id: "pg-ua-conn-1",
      api_key_id: null,
      api_key_name: "PG Test Key",
      endpoint: "/v1/chat/completions",
      ...overrides,
    });

    try {
      await kdb
        .insertInto("usage_history")
        .values([
          row({}),
          row({ provider: "PgAnthropic", model: "claude-x", success: 0, latency_ms: 200 }),
          row({ api_key_name: "PG Test Key 2", endpoint: "/v1/responses" }),
        ])
        .execute();

      const { unifiedSource, unifiedParams } = buildUnifiedSource({
        sinceIso: new Date(baseTimestamp.getTime() - 60_000).toISOString(),
        untilIso: null,
        rawCutoffDate: "1970-01-01",
        apiKeyWhere: "",
        apiKeyParams: {},
      });

      const summary = await getUsageSummary(unifiedSource, unifiedParams);
      assert.equal(Number(summary.totalRequests), 3);
      assert.equal(Number(summary.uniqueModels), 2);
      assert.equal(Number(summary.successfulRequests), 2);

      const daily = await getDailyUsage(unifiedSource, unifiedParams);
      assert.equal(daily.length, 1);
      assert.equal(Number(daily[0].requests), 3);

      const dailyCost = await getDailyCostRows(unifiedSource, unifiedParams);
      assert.ok(dailyCost.some((r) => r.provider === "pgopenai"));
      assert.ok(dailyCost.some((r) => r.provider === "pganthropic"));

      const heatmap = await getHeatmapRows(["timestamp >= @heatmapStart"], {
        heatmapStart: new Date(baseTimestamp.getTime() - 60_000).toISOString(),
      });
      assert.ok(heatmap.length >= 1);
      assert.ok(Number(heatmap[0].totalTokens) > 0);

      const modelRows = await getModelUsageRows(unifiedSource, unifiedParams);
      assert.ok(modelRows.some((r) => r.model === "gpt-4.1" && Number(r.requests) === 2));

      const providerCost = await getProviderCostRows(unifiedSource, unifiedParams);
      assert.equal(providerCost.length, 2);

      const providerUsage = await getProviderUsageRows(unifiedSource, unifiedParams);
      const openaiUsage = providerUsage.find((r) => r.provider === "pgopenai");
      assert.equal(Number(openaiUsage?.requests), 2);

      const accountWhere = `WHERE usage_history.timestamp >= @since AND usage_history.connection_id = @connId`;
      const accountParams = {
        since: new Date(baseTimestamp.getTime() - 60_000).toISOString(),
        connId: "pg-ua-conn-1",
      };
      const accountCost = await getAccountCostRows(accountWhere, accountParams);
      assert.ok(accountCost.length >= 1);

      const accountUsage = await getAccountUsageRows(accountWhere, accountParams);
      assert.equal(Number(accountUsage[0]?.requests), 3);

      const apiKeyWhere = `WHERE usage_history.timestamp >= @since AND ((usage_history.api_key_id IS NOT NULL AND usage_history.api_key_id != '') OR (usage_history.api_key_name IS NOT NULL AND usage_history.api_key_name != ''))`;
      const apiKeyParams = { since: accountParams.since };
      const apiKeyRows = await getApiKeyUsageRows(apiKeyWhere, apiKeyParams);
      assert.ok(apiKeyRows.length >= 2);

      const serviceTierRows = await getServiceTierUsageRows(unifiedSource, unifiedParams);
      assert.ok(serviceTierRows.some((r) => r.serviceTier === "standard"));

      const apiKeyMetadata = await getApiKeyMetadataRows(apiKeyWhere, apiKeyParams);
      assert.ok(apiKeyMetadata.some((r) => r.apiKeyName === "PG Test Key"));

      const weekly = await getWeeklyPatternRows(unifiedSource, unifiedParams);
      assert.ok(weekly.length >= 1);
      assert.ok(weekly.every((r) => /^[0-6]$/.test(r.dayOfWeek)));
      assert.equal(
        weekly.reduce((sum, r) => sum + Number(r.requests), 0),
        3
      );

      const endpointRows = await getEndpointUsageRows({
        sinceIso: new Date(baseTimestamp.getTime() - 60_000).toISOString(),
      });
      assert.ok(endpointRows.some((r) => r.endpoint === "/v1/chat/completions"));
      assert.ok(endpointRows.some((r) => r.endpoint === "/v1/responses"));

      const providerDaily = await getProviderDailyUsageRows(unifiedSource, unifiedParams);
      assert.ok(providerDaily.some((r) => r.provider === "pgopenai"));

      const allHistory = await getAllUsageHistory();
      assert.ok(allHistory.length >= 3);
    } finally {
      await kdb
        .deleteFrom("usage_history")
        .where("connection_id", "=", "pg-ua-conn-1")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
