import test from "node:test";
import assert from "node:assert/strict";

import {
  setReasoningCache,
  deleteReasoningCache,
  cleanupExpiredReasoning,
  clearAllReasoningCache,
  getReasoningCacheStats,
  getReasoningCacheEntries,
} from "../../../src/lib/db/reasoningCache";
import {
  ensurePostgresBootstrap,
  resetKyselyDb,
  getKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 *
 * getReasoningCache (the synchronous DB-fallback read) stays SQLite-only —
 * see src/lib/db/reasoningCache.ts module docstring — so it is not exercised
 * here; this test covers the write/admin/stats surface only.
 */
test(
  "reasoningCache (postgres) write/cleanup/stats/entries lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();

    try {
      await setReasoningCache("pg-rc-1", "deepseek", "deepseek-reasoner", "First reasoning chunk");
      await setReasoningCache("pg-rc-2", "kimi", "kimi-k2.5", "Second reasoning chunk");
      // Already-expired entry (ttlMs negative) — should be excluded from stats/entries and pruned by cleanup.
      await setReasoningCache(
        "pg-rc-expired",
        "deepseek",
        "deepseek-chat",
        "Expired chunk",
        -1_000
      );

      // Upsert / conflict path — re-storing the same key replaces the row instead of erroring.
      await setReasoningCache(
        "pg-rc-1",
        "deepseek",
        "deepseek-reasoner",
        "First reasoning chunk (updated)"
      );

      const stats = await getReasoningCacheStats();
      assert.equal(stats.totalEntries, 2);
      assert.ok(stats.byProvider.deepseek);
      assert.equal(stats.byProvider.deepseek.entries, 1);
      assert.ok(stats.byModel["kimi-k2.5"]);

      const entries = await getReasoningCacheEntries({ limit: 10 });
      const updated = entries.find((e) => e.toolCallId === "pg-rc-1");
      assert.ok(updated);
      assert.equal(updated.reasoning, "First reasoning chunk (updated)");
      assert.ok(
        !entries.some((e) => e.toolCallId === "pg-rc-expired"),
        "expired row must not be listed"
      );

      const cleanedUp = await cleanupExpiredReasoning();
      assert.equal(cleanedUp, 1);

      const deleted = await deleteReasoningCache("pg-rc-2");
      assert.equal(deleted, 1);

      const remainingAfterDelete = await getReasoningCacheEntries({ limit: 10 });
      assert.ok(!remainingAfterDelete.some((e) => e.toolCallId === "pg-rc-2"));

      const cleared = await clearAllReasoningCache();
      assert.ok(cleared >= 1);

      const finalStats = await getReasoningCacheStats();
      assert.equal(finalStats.totalEntries, 0);
    } finally {
      await kdb
        .deleteFrom("reasoning_cache")
        .where("tool_call_id", "like", "pg-rc-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
