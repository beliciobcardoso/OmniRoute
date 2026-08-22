import test from "node:test";
import assert from "node:assert/strict";

import {
  savePrompt,
  getActivePrompt,
  getPromptVersion,
  listPromptVersions,
  listPrompts,
  rollbackPrompt,
  renderPrompt,
} from "../../../src/lib/db/prompts";
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
  "prompts (postgres) save/get/list/rollback/render",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const slug = `pg-prompt-${Date.now()}`;

    try {
      const v1 = await savePrompt(slug, "Hello {{name}}", { variables: ["name"] });
      assert.equal(v1.version, 1);
      assert.equal(v1.isActive, true);

      const v1Again = await savePrompt(slug, "Hello {{name}}", { variables: ["name"] });
      assert.equal(v1Again.version, 1, "identical content should not create a new version");
      assert.equal(v1Again.id, v1.id);

      const v2 = await savePrompt(slug, "Hi {{name}}!", { variables: ["name"] });
      assert.equal(v2.version, 2);

      const active = await getActivePrompt(slug);
      assert.equal(active?.version, 2);
      assert.equal(active?.content, "Hi {{name}}!");

      const fetchedV1 = await getPromptVersion(slug, 1);
      assert.equal(fetchedV1?.content, "Hello {{name}}");
      assert.equal(fetchedV1?.isActive, false);

      const versions = await listPromptVersions(slug);
      assert.deepEqual(
        versions.map((v) => v.version),
        [2, 1]
      );

      const prompts = await listPrompts();
      const found = prompts.find((p) => p.slug === slug);
      assert.ok(found);
      assert.equal(found!.activeVersion, 2);
      assert.equal(found!.totalVersions, 2);

      const rolled = await rollbackPrompt(slug, 1);
      assert.equal(rolled?.version, 1);
      assert.equal(rolled?.isActive, true);

      const activeAfterRollback = await getActivePrompt(slug);
      assert.equal(activeAfterRollback?.version, 1);

      const rendered = await renderPrompt(slug, { name: "Ana" });
      assert.equal(rendered, "Hello Ana");
    } finally {
      await getKyselyDb()
        .deleteFrom("prompt_templates")
        .where("slug", "=", slug)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
