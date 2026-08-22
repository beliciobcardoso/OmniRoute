import test from "node:test";
import assert from "node:assert/strict";

import {
  getSessionAccountAffinity,
  upsertSessionAccountAffinity,
  touchSessionAccountAffinity,
  deleteSessionAccountAffinity,
  evictSessionAccountAffinityForConnection,
  cleanupStaleSessionAccountAffinities,
} from "../../../src/lib/db/sessionAccountAffinity";
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
  "sessionAccountAffinity (postgres) get/upsert/touch/evict/cleanup lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const session = `pg-session-${Date.now()}`;
    const provider = "codex";
    const ttl = 60_000;

    try {
      assert.equal(await getSessionAccountAffinity(session, provider, ttl), null);

      await upsertSessionAccountAffinity(session, provider, "conn-a", Date.now(), ttl);
      const pinned = await getSessionAccountAffinity(session, provider, ttl);
      assert.equal(pinned?.connectionId, "conn-a");

      await touchSessionAccountAffinity(session, provider, Date.now() + 1000, ttl);
      const touched = await getSessionAccountAffinity(session, provider, ttl, Date.now() + 1000);
      assert.equal(touched?.connectionId, "conn-a");

      const evictedWrongConn = await evictSessionAccountAffinityForConnection(
        session,
        provider,
        "conn-b"
      );
      assert.equal(evictedWrongConn, false);
      assert.ok(await getSessionAccountAffinity(session, provider, ttl));

      const evicted = await evictSessionAccountAffinityForConnection(session, provider, "conn-a");
      assert.equal(evicted, true);
      assert.equal(await getSessionAccountAffinity(session, provider, ttl), null);

      await upsertSessionAccountAffinity(session, provider, "conn-c", Date.now(), ttl);
      await deleteSessionAccountAffinity(session, provider);
      assert.equal(await getSessionAccountAffinity(session, provider, ttl), null);

      // Expired entry should be cleaned up.
      const expiredSession = `pg-session-expired-${Date.now()}`;
      const now = Date.now();
      await upsertSessionAccountAffinity(expiredSession, provider, "conn-d", now - 120_000, 1000);
      const deleted = await cleanupStaleSessionAccountAffinities(ttl, now);
      assert.ok(deleted >= 1);
      assert.equal(await getSessionAccountAffinity(expiredSession, provider, ttl, now), null);
    } finally {
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "session_account_affinity")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
