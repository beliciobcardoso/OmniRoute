import test from "node:test";
import assert from "node:assert/strict";

import {
  createKeyGroup,
  getKeyGroup,
  getAllKeyGroups,
  updateKeyGroup,
  deleteKeyGroup,
  addGroupPermission,
  getGroupPermissions,
  removeGroupPermission,
  clearGroupPermissions,
  addKeyToGroup,
  removeKeyFromGroup,
  getGroupMembers,
  getKeyGroupsForApiKey,
  getKeyGroupWithPermissions,
  checkKeyModelAccess,
} from "../../../src/lib/db/apiKeyGroups";
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
  "apiKeyGroups (postgres) CRUD/permissions/members/access-check lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    let groupId: string | null = null;

    try {
      const group = await createKeyGroup("PG Test Group", "desc");
      groupId = group.id;
      assert.equal(group.isActive, true);

      const fetched = await getKeyGroup(group.id);
      assert.equal(fetched?.name, "PG Test Group");

      const all = await getAllKeyGroups();
      assert.ok(all.some((g) => g.id === group.id));

      const updated = await updateKeyGroup(group.id, { name: "PG Renamed", isActive: false });
      assert.equal(updated?.name, "PG Renamed");
      assert.equal(updated?.isActive, false);

      await updateKeyGroup(group.id, { isActive: true });

      const allow = await addGroupPermission(group.id, "gpt-*", "allow");
      assert.equal(allow.modelPattern, "gpt-*");
      const deny = await addGroupPermission(group.id, "gpt-4-restricted", "deny");

      const perms = await getGroupPermissions(group.id);
      assert.equal(perms.length, 2);

      await addKeyToGroup("pg-test-key", group.id);
      const members = await getGroupMembers(group.id);
      assert.equal(members.length, 1);
      assert.equal(members[0].keyId, "pg-test-key");

      const groupsForKey = await getKeyGroupsForApiKey("pg-test-key");
      assert.ok(groupsForKey.some((g) => g.id === group.id));

      const access1 = await checkKeyModelAccess("pg-test-key", "gpt-4");
      assert.equal(access1.allowed, true);

      const access2 = await checkKeyModelAccess("pg-test-key", "gpt-4-restricted");
      assert.equal(access2.allowed, false);
      assert.equal(access2.deniedBy?.id, deny.id);

      const withPerms = await getKeyGroupWithPermissions(group.id);
      assert.equal(withPerms?.permissions.length, 2);
      assert.equal(withPerms?.memberCount, 1);

      await removeGroupPermission(allow.id);
      assert.equal((await getGroupPermissions(group.id)).length, 1);

      await removeKeyFromGroup("pg-test-key", group.id);
      assert.equal((await getGroupMembers(group.id)).length, 0);

      await clearGroupPermissions(group.id);
      assert.equal((await getGroupPermissions(group.id)).length, 0);

      const deleted = await deleteKeyGroup(group.id);
      assert.equal(deleted, true);
      assert.equal(await getKeyGroup(group.id), undefined);
      groupId = null;
    } finally {
      if (groupId) {
        await getKyselyDb()
          .deleteFrom("group_model_permissions")
          .where("group_id", "=", groupId)
          .execute()
          .catch(() => {});
        await getKyselyDb()
          .deleteFrom("key_group_members")
          .where("group_id", "=", groupId)
          .execute()
          .catch(() => {});
        await getKyselyDb()
          .deleteFrom("key_groups")
          .where("id", "=", groupId)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
