import test from "node:test";
import assert from "node:assert/strict";

import {
  createGroup,
  deleteGroup,
  getGroup,
  getGroupName,
  listGroups,
  renameGroup,
} from "../../../src/lib/db/quotaGroups";
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
  "quotaGroups (postgres) creates, reads, renames, and deletes groups",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const created = await createGroup(`pg-test-group-${Date.now()}`);
    try {
      assert.ok(created.id);
      assert.ok(created.createdAt);

      const found = await getGroup(created.id);
      assert.equal(found?.name, created.name);

      assert.equal(await getGroupName(created.id), created.name);
      assert.equal(await getGroupName("does-not-exist"), null);

      const groups = await listGroups();
      assert.ok(groups.some((g) => g.id === created.id));

      const renamed = await renameGroup(created.id, "pg-test-group-renamed");
      assert.equal(renamed, true);
      assert.equal(await getGroupName(created.id), "pg-test-group-renamed");

      assert.equal(await renameGroup("does-not-exist", "x"), false);

      // Guard: refuses deletion while a quota_pools row still references it.
      const db = getKyselyDb();
      const connId = `pg-test-conn-${Date.now()}`;
      await db
        .insertInto("provider_connections")
        .values({
          id: connId,
          provider: "openrouter",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
      const poolId = `pg-test-pool-${Date.now()}`;
      await db
        .insertInto("quota_pools")
        .values({ id: poolId, connection_id: connId, name: "blocking pool", group_id: created.id })
        .execute();

      await assert.rejects(() => deleteGroup(created.id), /pools/i);

      await db.deleteFrom("quota_pools").where("id", "=", poolId).execute();
      await db.deleteFrom("provider_connections").where("id", "=", connId).execute();

      assert.equal(await deleteGroup(created.id), true);
      assert.equal(await getGroup(created.id), null);
      assert.equal(await deleteGroup("does-not-exist"), false);

      await assert.rejects(() => deleteGroup("group-demo"), /group-demo/i);
    } finally {
      await getKyselyDb().deleteFrom("quota_groups").where("id", "=", created.id).execute();
      await resetKyselyDb();
    }
  }
);
