import test from "node:test";
import assert from "node:assert/strict";

import {
  upsertTokenLimit,
  listTokenLimits,
  getTokenLimitsForRequest,
  deleteTokenLimit,
  resetWindowIfElapsed,
  getWindowUsage,
  incrementWindowTokens,
  logTokenLimitReset,
} from "../../../src/lib/db/tokenLimits";
import {
  checkTokenLimits,
  recordTokenUsage,
  seedWindowUsageFromHistory,
  getCurrentWindowUsage,
  addWindowTokens,
  clearTokenLimitCache,
} from "../../../open-sse/services/tokenLimitCounter";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "tokenLimits (postgres) upsert/list/get/increment/check/record round trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();
    clearTokenLimitCache();

    const apiKeyId = `pg-tok-${Date.now()}`;
    const now = Date.now();
    let limitId: string | null = null;

    try {
      const limit = await upsertTokenLimit({
        apiKeyId,
        scopeType: "global",
        tokenLimit: 1000,
        resetInterval: "monthly",
      });
      limitId = limit.id;
      assert.equal(limit.tokenLimit, 1000);
      assert.equal(limit.enabled, true);

      const listed = await listTokenLimits(apiKeyId);
      assert.equal(listed.length, 1);

      const forRequest = await getTokenLimitsForRequest(apiKeyId, "openai", "gpt-4o");
      assert.equal(forRequest.length, 1);

      const { windowStart } = resetWindowIfElapsed(limit, now);
      assert.equal(await getWindowUsage(limit, now), 0);

      const total1 = await incrementWindowTokens(limit.id, windowStart, 100);
      assert.equal(total1, 100);
      const total2 = await incrementWindowTokens(limit.id, windowStart, 50);
      assert.equal(total2, 150);
      assert.equal(await getWindowUsage(limit, now), 150);

      await logTokenLimitReset(limit.id, 150, windowStart);

      // checkTokenLimits: not yet breached (150 < 1000).
      const noBreach = await checkTokenLimits(apiKeyId, "openai", "gpt-4o", now);
      assert.equal(noBreach, null);

      // Push usage to/over the limit directly, then verify the breach.
      await incrementWindowTokens(limit.id, windowStart, 900);
      const breach = await checkTokenLimits(apiKeyId, "openai", "gpt-4o", now);
      assert.ok(breach);
      assert.equal(breach!.scopeType, "global");
      assert.equal(breach!.remaining, 0);

      // getCurrentWindowUsage / addWindowTokens accelerator path.
      const accelUsage = await getCurrentWindowUsage(limit, now, true);
      assert.equal(accelUsage, 1050);
      const afterAdd = await addWindowTokens(limit, 10, now);
      assert.equal(afterAdd, 1060);

      // recordTokenUsage is fire-and-forget — flush microtasks then verify.
      recordTokenUsage(apiKeyId, "openai", "gpt-4o", 5);
      await flush();
      await flush();
      await flush();
      assert.equal(await getWindowUsage(limit, now), 1065);

      const deleted = await deleteTokenLimit(limit.id);
      assert.equal(deleted, true);
      assert.equal((await listTokenLimits(apiKeyId)).length, 0);
      limitId = null;

      // seedWindowUsageFromHistory: no usage_history rows for this key → 0.
      const otherLimit = await upsertTokenLimit({
        apiKeyId,
        scopeType: "global",
        tokenLimit: 500,
        resetInterval: "monthly",
      });
      limitId = otherLimit.id;
      assert.equal(await seedWindowUsageFromHistory(otherLimit, now), 0);
    } finally {
      if (limitId) {
        await getKyselyDb()
          .deleteFrom("api_key_token_counters")
          .where("limit_id", "=", limitId)
          .execute()
          .catch(() => {});
        await getKyselyDb()
          .deleteFrom("api_key_token_limit_reset_logs")
          .where("limit_id", "=", limitId)
          .execute()
          .catch(() => {});
        await getKyselyDb()
          .deleteFrom("api_key_token_limits")
          .where("id", "=", limitId)
          .execute()
          .catch(() => {});
      }
      clearTokenLimitCache();
      await resetKyselyDb();
    }
  }
);
