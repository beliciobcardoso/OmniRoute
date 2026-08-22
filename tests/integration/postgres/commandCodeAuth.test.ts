import test from "node:test";
import assert from "node:assert/strict";

import {
  hashCommandCodeAuthState,
  createPendingCommandCodeAuthSession,
  markCommandCodeAuthSessionReceived,
  getCommandCodeAuthSessionSafeStatus,
  consumeCommandCodeAuthSecret,
} from "../../../src/lib/db/commandCodeAuth";
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
  "commandCodeAuth (postgres) pending/expire/receive/consume lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const expiredStateHash = hashCommandCodeAuthState(`pg-expired-${Date.now()}`);
    const receivedStateHash = hashCommandCodeAuthState(`pg-received-${Date.now()}`);

    try {
      // expiry path
      const pendingExpired = await createPendingCommandCodeAuthSession({
        stateHash: expiredStateHash,
        expiresAt: "2026-01-01T00:00:00.000Z",
      });
      assert.equal(pendingExpired.status, "pending");
      const expiredStatus = await getCommandCodeAuthSessionSafeStatus(expiredStateHash);
      assert.equal(expiredStatus?.status, "expired");

      // receive + consume path
      await createPendingCommandCodeAuthSession({
        stateHash: receivedStateHash,
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      const received = await markCommandCodeAuthSessionReceived({
        stateHash: receivedStateHash,
        apiKey: "sk-pg-test-command-code",
        metadata: { userId: "pg-user-1" },
      });
      assert.equal(received?.status, "received");
      assert.equal(received?.metadata?.userId, "pg-user-1");

      const consumed = await consumeCommandCodeAuthSecret(receivedStateHash);
      assert.equal(consumed?.apiKey, "sk-pg-test-command-code");
      assert.equal(consumed?.status, "applied");

      // consuming again returns null; status stays applied
      assert.equal(await consumeCommandCodeAuthSecret(receivedStateHash), null);
      assert.equal(
        (await getCommandCodeAuthSessionSafeStatus(receivedStateHash))?.status,
        "applied"
      );
    } finally {
      await getKyselyDb()
        .deleteFrom("command_code_auth_sessions")
        .where("state_hash", "in", [expiredStateHash, receivedStateHash])
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
