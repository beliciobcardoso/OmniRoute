import test from "node:test";
import assert from "node:assert/strict";

import {
  checkQuota,
  issueRegisteredKey,
  getRegisteredKey,
  listRegisteredKeys,
  revokeRegisteredKey,
  validateRegisteredKey,
  incrementRegisteredKeyUsage,
  setProviderKeyLimit,
  setAccountKeyLimit,
  getProviderKeyLimit,
  getAccountKeyLimit,
} from "../../../src/lib/db/registeredKeys";
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
  "registeredKeys (postgres) issue/validate/quota/revoke",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const provider = `pg-provider-${Date.now()}`;
    const accountId = `pg-account-${Date.now()}`;
    const keyIds: string[] = [];

    try {
      // basic issue + get + validate + budget exhaustion
      const issued = await issueRegisteredKey({
        name: "PG Key",
        provider,
        accountId,
        dailyBudget: 2,
        hourlyBudget: 2,
      });
      if ("idempotencyConflict" in issued) throw new Error("unexpected conflict");
      keyIds.push(issued.id);
      assert.match(issued.rawKey, /^ork_/);

      const fetched = await getRegisteredKey(issued.id);
      assert.equal(fetched?.name, "PG Key");
      assert.equal(fetched?.dailyBudget, 2);

      assert.equal((await validateRegisteredKey(issued.rawKey))?.id, issued.id);
      await incrementRegisteredKeyUsage(issued.id);
      await incrementRegisteredKeyUsage(issued.id);
      assert.equal(await validateRegisteredKey(issued.rawKey), null, "budget exhausted");

      // idempotency conflict
      const dup = await issueRegisteredKey({
        name: "PG Key Dup",
        provider,
        accountId,
        idempotencyKey: "pg-idem-1",
      });
      if (!("idempotencyConflict" in dup)) {
        keyIds.push(dup.id);
      }
      const dup2 = await issueRegisteredKey({
        name: "PG Key Dup 2",
        provider,
        accountId,
        idempotencyKey: "pg-idem-1",
      });
      assert.ok("idempotencyConflict" in dup2);

      const list = await listRegisteredKeys({ provider });
      assert.ok(list.length >= 2);

      // revoke
      assert.equal(await revokeRegisteredKey(issued.id), true);
      assert.equal(await revokeRegisteredKey(issued.id), false);

      // provider/account quota limits
      await setProviderKeyLimit(provider, {
        maxActiveKeys: 1,
        dailyIssueLimit: 100,
        hourlyIssueLimit: 100,
      });
      await setAccountKeyLimit(accountId, {
        maxActiveKeys: 1,
        dailyIssueLimit: 100,
        hourlyIssueLimit: 100,
      });
      const providerLimit = await getProviderKeyLimit(provider);
      assert.equal(providerLimit?.maxActiveKeys, 1);
      const accountLimit = await getAccountKeyLimit(accountId);
      assert.equal(accountLimit?.maxActiveKeys, 1);

      // maxActiveKeys=1 and we still have 2 active (dup, dup? — dup2 is a conflict so
      // no new row was created); ensure quota check reports MAX_ACTIVE_KEYS_EXCEEDED
      const quota = await checkQuota(provider, accountId);
      assert.equal(quota.allowed, false);
      assert.equal(quota.errorCode, "MAX_ACTIVE_KEYS_EXCEEDED");
    } finally {
      const db = getKyselyDb();
      for (const id of keyIds) {
        await db
          .deleteFrom("registered_keys")
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
      await db
        .deleteFrom("provider_key_limits")
        .where("provider", "=", provider)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom("account_key_limits")
        .where("account_id", "=", accountId)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
