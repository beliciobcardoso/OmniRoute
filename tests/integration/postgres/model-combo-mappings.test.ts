import test from "node:test";
import assert from "node:assert/strict";

import {
  getModelComboMappings,
  getModelComboMappingById,
  createModelComboMapping,
  updateModelComboMapping,
  deleteModelComboMapping,
  resolveComboForModel,
} from "../../../src/lib/db/modelComboMappings";
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
  "modelComboMappings (postgres) CRUD + glob resolution against a real combo",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const comboId = `pg-combo-${Date.now()}`;
    const now = new Date().toISOString();
    let mappingId: string | undefined;

    try {
      await getKyselyDb()
        .insertInto("combos")
        .values({
          id: comboId,
          name: "PG Test Combo",
          data: JSON.stringify({ isActive: true, targets: [] }),
          created_at: now,
          updated_at: now,
        })
        .execute();

      const created = await createModelComboMapping({
        pattern: "claude-sonnet-*",
        comboId,
        priority: 10,
        enabled: true,
        description: "PG mapping",
      });
      mappingId = created.id;
      assert.equal(created.comboId, comboId);
      assert.equal(created.enabled, true);

      const fetched = await getModelComboMappingById(created.id);
      assert.equal(fetched?.comboName, "PG Test Combo");

      const all = await getModelComboMappings();
      assert.ok(all.some((m) => m.id === created.id));

      const resolved = await resolveComboForModel("claude-sonnet-4");
      assert.deepEqual(resolved, { isActive: true, targets: [] });

      const noMatch = await resolveComboForModel("gpt-4o");
      assert.equal(noMatch, null);

      const updated = await updateModelComboMapping(created.id, { enabled: false });
      assert.equal(updated?.enabled, false);

      // Disabled mapping no longer resolves.
      assert.equal(await resolveComboForModel("claude-sonnet-4"), null);

      assert.equal(await deleteModelComboMapping(created.id), true);
      assert.equal(await getModelComboMappingById(created.id), null);
      assert.equal(await deleteModelComboMapping(created.id), false);
      mappingId = undefined;
    } finally {
      if (mappingId) await deleteModelComboMapping(mappingId).catch(() => {});
      await getKyselyDb()
        .deleteFrom("combos")
        .where("id", "=", comboId)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
