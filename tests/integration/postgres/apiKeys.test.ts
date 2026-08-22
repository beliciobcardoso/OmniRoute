import test from "node:test";
import assert from "node:assert/strict";

import {
  createApiKey,
  getApiKeys,
  getApiKeyById,
  updateApiKeyPermissions,
  validateApiKey,
  getApiKeyMetadata,
  regenerateApiKey,
  revokeApiKey,
  setApiKeyExpiry,
  deleteApiKey,
} from "../../../src/lib/db/apiKeys";
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
  "apiKeys (postgres) create/validate/metadata/update/regenerate/revoke/expiry/delete lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    let keyId: string | null = null;

    try {
      const created = await createApiKey("PG Test Key", "machine-pg-1", ["chat"]);
      keyId = created.id;
      assert.ok(created.key.startsWith("sk-") || created.key.length > 0);

      const fetched = await getApiKeyById(created.id);
      assert.equal(fetched?.name, "PG Test Key");

      const all = await getApiKeys();
      assert.ok(all.some((k) => k.id === created.id));

      const validBefore = await validateApiKey(created.key);
      assert.equal(validBefore, true);

      const metadata = await getApiKeyMetadata(created.key);
      assert.equal(metadata?.id, created.id);
      assert.equal(metadata?.isActive, true);
      assert.equal(metadata?.isBanned, false);
      assert.deepEqual(metadata?.scopes, ["chat"]);

      const updated = await updateApiKeyPermissions(created.id, {
        allowedModels: ["gpt-4"],
        maxRequestsPerDay: 1000,
        maxRequestsPerMinute: 60,
        maxSessions: 5,
        isBanned: false,
        scopes: ["chat", "manage"],
        rateLimits: [{ limit: 100, window: 60000 }],
      });
      assert.equal(updated, true);

      const metaAfter = await getApiKeyMetadata(created.key);
      assert.deepEqual(metaAfter?.allowedModels, ["gpt-4"]);
      assert.equal(metaAfter?.maxRequestsPerDay, 1000);
      assert.equal(metaAfter?.maxRequestsPerMinute, 60);
      assert.equal(metaAfter?.maxSessions, 5);
      assert.deepEqual(metaAfter?.scopes, ["chat", "manage"]);

      const regen = await regenerateApiKey(created.id);
      assert.ok(regen?.key);
      assert.notEqual(regen?.key, created.key);

      const validOldKey = await validateApiKey(created.key);
      assert.equal(validOldKey, false);
      const validNewKey = await validateApiKey(regen!.key);
      assert.equal(validNewKey, true);

      const expirySet = await setApiKeyExpiry(created.id, "2999-01-01T00:00:00.000Z");
      assert.equal(expirySet, true);
      const afterExpiry = await getApiKeyById(created.id);
      assert.equal(afterExpiry?.expiresAt, "2999-01-01T00:00:00.000Z");

      const revoked = await revokeApiKey(created.id);
      assert.equal(revoked, true);
      const validAfterRevoke = await validateApiKey(regen!.key);
      assert.equal(validAfterRevoke, false);

      const deleted = await deleteApiKey(created.id);
      assert.equal(deleted, true);
      assert.equal(await getApiKeyById(created.id), null);
      keyId = null;
    } finally {
      if (keyId) {
        await getKyselyDb()
          .deleteFrom("api_keys")
          .where("id", "=", keyId)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
