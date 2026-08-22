import test from "node:test";
import assert from "node:assert/strict";

import {
  getCombos,
  getComboById,
  getComboByName,
  getComboByNameInsensitive,
  createCombo,
  updateCombo,
  reorderCombos,
  deleteCombo,
  deleteComboByName,
  setActiveCombo,
} from "../../../src/lib/db/combos";
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
  "combos (postgres) create/get/update/reorder/delete lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const createdIds: string[] = [];

    try {
      const comboA = await createCombo({
        name: "PG-Combo-A",
        models: ["gpt-4"],
        context_cache_protection: true,
      });
      createdIds.push(comboA.id as string);
      assert.equal(comboA.name, "PG-Combo-A");
      assert.equal(comboA.context_cache_protection, true);

      const comboB = await createCombo({ name: "PG-Combo-B", models: ["claude-3"] });
      createdIds.push(comboB.id as string);

      const fetched = await getComboById(comboA.id as string);
      assert.equal(fetched?.name, "PG-Combo-A");

      const byName = await getComboByName("PG-Combo-B");
      assert.equal(byName?.id, comboB.id);

      const byNameInsensitive = await getComboByNameInsensitive("pg-combo-a");
      assert.equal(byNameInsensitive?.id, comboA.id);

      const all = await getCombos();
      assert.ok(all.some((c) => c.id === comboA.id));
      assert.ok(all.some((c) => c.id === comboB.id));

      const updated = await updateCombo(comboA.id as string, { models: ["gpt-4o"] });
      const updatedModels = updated?.models as Array<{ model?: string }> | undefined;
      assert.equal(updatedModels?.[0]?.model, "gpt-4o");

      const reordered = await reorderCombos([comboB.id as string, comboA.id as string]);
      const reorderedNames = reordered.map((c) => c.name);
      const idxA = reorderedNames.indexOf("PG-Combo-A");
      const idxB = reorderedNames.indexOf("PG-Combo-B");
      assert.ok(idxB < idxA);

      await setActiveCombo("PG-Combo-A");
      const activeRow = await getKyselyDb()
        .selectFrom("key_value")
        .select("value")
        .where("namespace", "=", "settings")
        .where("key", "=", "activeCombo")
        .executeTakeFirst();
      assert.equal(activeRow?.value, JSON.stringify("PG-Combo-A"));

      const deletedByName = await deleteComboByName("PG-Combo-B");
      assert.equal(deletedByName, true);
      assert.equal(await getComboByName("PG-Combo-B"), null);
      createdIds.splice(createdIds.indexOf(comboB.id as string), 1);

      const deleted = await deleteCombo(comboA.id as string);
      assert.equal(deleted, true);
      assert.equal(await getComboById(comboA.id as string), null);
      createdIds.splice(createdIds.indexOf(comboA.id as string), 1);
    } finally {
      const kdb = getKyselyDb();
      for (const id of createdIds) {
        await kdb
          .deleteFrom("combos")
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "=", "settings")
        .where("key", "=", "activeCombo")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
