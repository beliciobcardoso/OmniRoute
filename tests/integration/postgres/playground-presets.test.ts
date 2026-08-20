import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlaygroundPreset,
  deletePlaygroundPreset,
  getPlaygroundPreset,
  listPlaygroundPresets,
  updatePlaygroundPreset,
} from "../../../src/lib/db/playgroundPresets";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "playgroundPresets (postgres) creates, reads, updates, and deletes presets",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const created = await createPlaygroundPreset({
      name: "PG Preset",
      endpoint: "/v1/chat/completions",
      model: "gpt-4o",
      system: "You are helpful.",
      params: { temperature: 0.7 },
    });

    try {
      assert.ok(created.id);
      assert.equal(created.params.temperature, 0.7);

      const fetched = await getPlaygroundPreset(created.id);
      assert.equal(fetched?.name, "PG Preset");

      const all = await listPlaygroundPresets();
      assert.ok(all.some((p) => p.id === created.id));

      const updated = await updatePlaygroundPreset(created.id, { model: "gpt-4o-mini" });
      assert.equal(updated?.model, "gpt-4o-mini");
      assert.equal(updated?.name, "PG Preset", "untouched fields stay unchanged");

      // Empty patch returns the row unchanged.
      const unchanged = await updatePlaygroundPreset(created.id, {});
      assert.equal(unchanged?.model, "gpt-4o-mini");

      assert.equal(await updatePlaygroundPreset("does-not-exist", { model: "x" }), null);

      assert.equal(await deletePlaygroundPreset(created.id), true);
      assert.equal(await getPlaygroundPreset(created.id), null);
      assert.equal(await deletePlaygroundPreset(created.id), false);
    } finally {
      await deletePlaygroundPreset(created.id).catch(() => {});
      await resetKyselyDb();
    }
  }
);
