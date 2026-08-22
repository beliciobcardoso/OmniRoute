import test from "node:test";
import assert from "node:assert/strict";

import { recordCacheStats, getCacheStatsSummary } from "../../../src/lib/db/compressionCacheStats";
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
  "compressionCacheStats (postgres) record/summarize lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      await recordCacheStats({
        provider: "pg-test-provider",
        model: "pg-test-model",
        compressionMode: "lite",
        cacheControlPresent: true,
        estimatedCacheHit: true,
        tokensSavedCompression: 100,
        tokensSavedCaching: 50,
        netSavings: 150,
      });
      await recordCacheStats({
        provider: "pg-test-provider",
        compressionMode: "standard",
        cacheControlPresent: false,
        estimatedCacheHit: false,
        tokensSavedCompression: 0,
        tokensSavedCaching: 0,
        netSavings: 0,
      });

      const summary = await getCacheStatsSummary();
      assert.ok(summary.totalRequests >= 2);
      const providerSummary = summary.byProvider["pg-test-provider"];
      assert.ok(providerSummary);
      assert.equal(providerSummary.count, 2);
      assert.equal(providerSummary.cacheHitRate, 0.5);
      assert.equal(providerSummary.avgNetSavings, 75);

      const future = new Date(Date.now() + 86400000);
      const futureSummary = await getCacheStatsSummary(future);
      assert.equal(futureSummary.totalRequests, 0);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("compression_cache_stats")
        .where("provider", "=", "pg-test-provider")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
