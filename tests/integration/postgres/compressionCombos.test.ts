import test from "node:test";
import assert from "node:assert/strict";

import {
  listCompressionCombos,
  getCompressionCombo,
  getDefaultCompressionCombo,
  createCompressionCombo,
  updateCompressionCombo,
  deleteCompressionCombo,
  setDefaultCompressionCombo,
  getAssignmentsForCompressionCombo,
  getCompressionComboForRoutingCombo,
  assignRoutingCombo,
  unassignRoutingCombo,
  setEngineInDefaultCombo,
  updateAssignments,
} from "../../../src/lib/db/compressionCombos";
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
  "compressionCombos (postgres) CRUD/default/assignment lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();

    try {
      // Seeded default combo exists on first access.
      const seeded = await getDefaultCompressionCombo();
      assert.ok(seeded);
      assert.equal(seeded?.isDefault, true);

      const combos = await listCompressionCombos();
      assert.ok(combos.some((c) => c.id === seeded?.id));

      // Create + fetch.
      const created = await createCompressionCombo({
        name: "PG Stacked",
        pipeline: [
          { engine: "rtk", intensity: "standard" },
          { engine: "caveman", intensity: "full" },
        ],
        languagePacks: ["en", "pt-BR"],
      });
      assert.equal(created.name, "PG Stacked");
      assert.equal((await getCompressionCombo(created.id))?.name, "PG Stacked");

      // Update.
      const updated = await updateCompressionCombo(created.id, { description: "Updated via PG" });
      assert.equal(updated?.description, "Updated via PG");

      // Set as default and verify only one row remains default.
      assert.equal(await setDefaultCompressionCombo(created.id), true);
      const newDefault = await getDefaultCompressionCombo();
      assert.equal(newDefault?.id, created.id);
      assert.equal((await getCompressionCombo(seeded!.id))?.isDefault, false);

      // Engine toggle on the default combo.
      const withHeadroom = await setEngineInDefaultCombo("headroom", true);
      assert.ok(withHeadroom?.pipeline.some((s) => s.engine === "headroom"));
      const withoutHeadroom = await setEngineInDefaultCombo("headroom", false);
      assert.ok(!withoutHeadroom?.pipeline.some((s) => s.engine === "headroom"));

      // Routing combo assignment (single + bulk).
      assert.equal(await assignRoutingCombo(created.id, "pg-routing-a"), true);
      assert.equal((await getCompressionComboForRoutingCombo("pg-routing-a"))?.id, created.id);
      const assignments = await getAssignmentsForCompressionCombo(created.id);
      assert.deepEqual(
        assignments.map((a) => a.routingComboId),
        ["pg-routing-a"]
      );

      assert.equal(await updateAssignments(created.id, ["pg-routing-b", "pg-routing-c"]), true);
      assert.equal(await getCompressionComboForRoutingCombo("pg-routing-a"), null);
      assert.equal((await getCompressionComboForRoutingCombo("pg-routing-b"))?.id, created.id);

      assert.equal(await unassignRoutingCombo(created.id, "pg-routing-b"), true);
      assert.equal(await getCompressionComboForRoutingCombo("pg-routing-b"), null);

      // Cannot delete the default combo; can delete a non-default one after handing off default.
      assert.equal(await deleteCompressionCombo(created.id), false);
      assert.equal(await setDefaultCompressionCombo(seeded!.id), true);
      assert.equal(await deleteCompressionCombo(created.id), true);
      assert.equal(await getCompressionCombo(created.id), null);
    } finally {
      await kdb
        .deleteFrom("compression_combo_assignments")
        .where("routing_combo_id", "like", "pg-routing-%")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("compression_combos")
        .where("name", "=", "PG Stacked")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
