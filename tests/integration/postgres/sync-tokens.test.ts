import test from "node:test";
import assert from "node:assert/strict";

import {
  listSyncTokens,
  getSyncTokenById,
  getSyncTokenByHash,
  createSyncTokenRecord,
  revokeSyncToken,
  touchSyncTokenLastUsed,
} from "../../../src/lib/db/syncTokens";
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
  "syncTokens (postgres) create/list/get/touch/revoke round trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const name = `pg-sync-token-${Date.now()}`;
    const tokenHash = `hash-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let createdId: string | null = null;

    try {
      const created = await createSyncTokenRecord({ name, tokenHash, syncApiKeyId: null });
      createdId = created.id;
      assert.equal(created.name, name);
      assert.equal(created.revokedAt, null);

      const byId = await getSyncTokenById(created.id);
      assert.ok(byId);
      assert.equal(byId!.tokenHash, tokenHash);

      const byHash = await getSyncTokenByHash(tokenHash);
      assert.ok(byHash);
      assert.equal(byHash!.id, created.id);

      const all = await listSyncTokens();
      assert.ok(all.some((t) => t.id === created.id));

      const touched = await touchSyncTokenLastUsed(created.id);
      assert.equal(touched, true);
      const afterTouch = await getSyncTokenById(created.id);
      assert.ok(afterTouch!.lastUsedAt);

      const revoked = await revokeSyncToken(created.id);
      assert.ok(revoked);
      assert.ok(revoked!.revokedAt);

      // Idempotent — revoking twice returns the already-revoked record.
      const revokedAgain = await revokeSyncToken(created.id);
      assert.equal(revokedAgain!.revokedAt, revoked!.revokedAt);

      // Unique constraint on token_hash.
      await assert.rejects(() =>
        createSyncTokenRecord({ name: "dup", tokenHash, syncApiKeyId: null })
      );
    } finally {
      if (createdId) {
        await getKyselyDb()
          .deleteFrom("sync_tokens")
          .where("id", "=", createdId)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
