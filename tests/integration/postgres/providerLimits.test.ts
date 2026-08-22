import test from "node:test";
import assert from "node:assert/strict";

import {
  getProviderLimitsCache,
  getAllProviderLimitsCache,
  setProviderLimitsCache,
  setProviderLimitsCacheBatch,
  deleteProviderLimitsCache,
} from "../../../src/lib/db/providerLimits";
import {
  getKyselyDb,
  ensurePostgresBootstrap,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "providerLimits (postgres) get/getAll/set/batch/overwrite/delete",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const connA = `pg-conn-a-${Date.now()}`;
    const connB = `pg-conn-b-${Date.now()}`;
    const connC = `pg-conn-c-${Date.now()}`;

    try {
      assert.equal(await getProviderLimitsCache(connA), null);

      const entryA = await setProviderLimitsCache(connA, {
        quotas: { remaining: 12 },
        plan: "pro",
        message: "ok",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        source: "sync",
      });
      assert.equal(entryA.plan, "pro");

      const fetched = await getProviderLimitsCache(connA);
      assert.deepEqual(fetched, entryA);

      // overwrite via onConflict
      await setProviderLimitsCache(connA, { ...entryA, plan: "team" });
      assert.equal((await getProviderLimitsCache(connA))?.plan, "team");

      const inserted = await setProviderLimitsCacheBatch([
        {
          connectionId: connB,
          entry: {
            quotas: { remaining: 10 },
            plan: { tier: "team" },
            message: null,
            fetchedAt: "2026-01-01T01:00:00.000Z",
          },
        },
        {
          connectionId: connC,
          entry: {
            quotas: null,
            plan: null,
            message: "empty",
            fetchedAt: "2026-01-01T02:00:00.000Z",
          },
        },
      ]);
      assert.equal(inserted, 2);

      const all = await getAllProviderLimitsCache();
      assert.ok(connA in all);
      assert.ok(connB in all);
      assert.ok(connC in all);

      await deleteProviderLimitsCache(connB);
      assert.equal(await getProviderLimitsCache(connB), null);
    } finally {
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "providerLimitsCache")
        .where("key", "in", [connA, connB, connC])
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
