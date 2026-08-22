import test from "node:test";
import assert from "node:assert/strict";

import {
  getModelCap,
  listModelCaps,
  setModelCap,
  deleteModelCap,
} from "../../../src/lib/db/quotaModelCaps";
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
  "quotaModelCaps (postgres) get/list/set/overwrite/delete",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const poolId = `pg-pool-${Date.now()}`;
    const apiKeyId = `pg-key-${Date.now()}`;

    try {
      assert.equal(await getModelCap(poolId, apiKeyId, "gpt-4o"), null);

      await setModelCap({
        poolId,
        apiKeyId,
        model: "gpt-4o",
        capValue: 100,
        capUnit: "requests",
      });
      const cap = await getModelCap(poolId, apiKeyId, "gpt-4o");
      assert.ok(cap);
      assert.equal(cap!.capValue, 100);
      assert.equal(cap!.capUnit, "requests");

      await setModelCap({
        poolId,
        apiKeyId,
        model: "claude-3",
        capValue: 50,
        capUnit: "tokens",
      });

      const list = await listModelCaps(poolId, apiKeyId);
      assert.equal(list.length, 2);
      assert.deepEqual(new Set(list.map((c) => c.model)), new Set(["gpt-4o", "claude-3"]));

      // overwrite via onConflict
      await setModelCap({
        poolId,
        apiKeyId,
        model: "gpt-4o",
        capValue: 200,
        capUnit: "requests",
      });
      const capAfter = await getModelCap(poolId, apiKeyId, "gpt-4o");
      assert.equal(capAfter!.capValue, 200);

      await deleteModelCap(poolId, apiKeyId, "gpt-4o");
      assert.equal(await getModelCap(poolId, apiKeyId, "gpt-4o"), null);

      const listAfterDelete = await listModelCaps(poolId, apiKeyId);
      assert.equal(listAfterDelete.length, 1);
      assert.equal(listAfterDelete[0].model, "claude-3");
    } finally {
      await getKyselyDb()
        .deleteFrom("quota_allocation_model_caps")
        .where("pool_id", "=", poolId)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
