import test from "node:test";
import assert from "node:assert/strict";

import { updateSkill } from "../../../src/lib/db/skills";
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
  "updateSkill (postgres) applies allowlisted patch, ignores unknown columns, returns 0 for no-op/missing",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const id = `pg-skill-${Date.now()}`;
    const now = new Date().toISOString();

    try {
      await getKyselyDb()
        .insertInto("skills")
        .values({
          id,
          api_key_id: "pg-test-key",
          name: "PG Test Skill",
          version: "1.0.0",
          schema: "{}",
          handler: "noop",
          enabled: 1,
          mode: "auto",
          created_at: now,
          updated_at: now,
        })
        .execute();

      const changed = await updateSkill(id, { enabled: false, mode: "off" });
      assert.equal(changed, 1);

      const row = await getKyselyDb()
        .selectFrom("skills")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      assert.equal(Number(row?.enabled), 0);
      assert.equal(row?.mode, "off");
      assert.notEqual(row?.updated_at, now);

      // Unknown columns are silently ignored; injection attempt must not throw.
      const patch = { enabled: true, "'; DROP TABLE skills; --": 1 } as Record<string, unknown>;
      const changed2 = await updateSkill(id, patch as Parameters<typeof updateSkill>[1]);
      assert.equal(changed2, 1);
      const row2 = await getKyselyDb()
        .selectFrom("skills")
        .select("enabled")
        .where("id", "=", id)
        .executeTakeFirst();
      assert.equal(Number(row2?.enabled), 1);

      // Empty/all-unknown patch → 0 changes, no query issued.
      const noop = await updateSkill(id, { unknownField: "x" } as Parameters<
        typeof updateSkill
      >[1]);
      assert.equal(noop, 0);

      // Non-existent id → 0 changes.
      const missing = await updateSkill("does-not-exist", { enabled: true });
      assert.equal(missing, 0);
    } finally {
      await getKyselyDb()
        .deleteFrom("skills")
        .where("id", "=", id)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
