import test from "node:test";
import assert from "node:assert/strict";

import {
  getServiceModels,
  saveServiceModels,
  markAllUnavailable,
} from "../../../src/lib/db/serviceModels";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "serviceModels (postgres) save/get round trip, soft-delete pruning, and markAllUnavailable",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const tool = `pg-tool-${Date.now()}`;

    try {
      assert.deepEqual(await getServiceModels(tool), []);

      await saveServiceModels(tool, [{ id: "model-a" }, { id: "model-b" }]);
      const afterFirstSave = await getServiceModels(tool);
      assert.equal(afterFirstSave.length, 2);
      assert.ok(afterFirstSave.every((m) => m.available === true));

      // model-a pruned (soft-deleted), model-c new.
      await saveServiceModels(tool, [{ id: "model-b" }, { id: "model-c" }]);
      const afterSecondSave = await getServiceModels(tool);
      const byId = Object.fromEntries(afterSecondSave.map((m) => [m.id, m]));
      assert.equal(byId["model-a"].available, false);
      assert.equal(byId["model-b"].available, true);
      assert.equal(byId["model-c"].available, true);

      await markAllUnavailable(tool);
      const afterMarkAll = await getServiceModels(tool);
      assert.equal(afterMarkAll.length, 3);
      assert.ok(afterMarkAll.every((m) => m.available === false));

      // Saving [] for a tool with no stored history hits the delete path.
      const emptyTool = `${tool}-empty`;
      await saveServiceModels(emptyTool, []);
      assert.deepEqual(await getServiceModels(emptyTool), []);
    } finally {
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "serviceModels")
        .where("key", "=", tool)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
