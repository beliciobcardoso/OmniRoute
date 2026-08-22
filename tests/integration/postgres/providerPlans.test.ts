import test from "node:test";
import assert from "node:assert/strict";

import { getPlan, listPlans, upsertPlan, deletePlan } from "../../../src/lib/db/providerPlans";
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
  "providerPlans (postgres) get/list/upsert/overwrite/delete",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const connId = `pg-conn-${Date.now()}`;

    try {
      assert.equal(await getPlan(connId), null);

      await upsertPlan(
        connId,
        "openai",
        [{ unit: "requests", window: "daily", limit: 100 }],
        "manual"
      );
      const plan = await getPlan(connId);
      assert.ok(plan);
      assert.equal(plan!.provider, "openai");
      assert.equal(plan!.dimensions.length, 1);
      assert.equal(plan!.dimensions[0].limit, 100);
      assert.equal(plan!.source, "manual");

      // overwrite via onConflict
      await upsertPlan(
        connId,
        "openai",
        [
          { unit: "requests", window: "daily", limit: 200 },
          { unit: "tokens", window: "5h", limit: 5000 },
        ],
        "auto"
      );
      const updated = await getPlan(connId);
      assert.equal(updated!.dimensions.length, 2);
      assert.equal(updated!.source, "auto");

      const all = await listPlans();
      assert.ok(all.some((p) => p.connectionId === connId));

      const deleted = await deletePlan(connId);
      assert.equal(deleted, true);
      assert.equal(await getPlan(connId), null);

      const deletedAgain = await deletePlan(connId);
      assert.equal(deletedAgain, false);
    } finally {
      await getKyselyDb()
        .deleteFrom("provider_plans")
        .where("connection_id", "=", connId)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
