import test from "node:test";
import assert from "node:assert/strict";

import {
  getPersistedCreditBalance,
  getAllPersistedCreditBalances,
  persistCreditBalance,
} from "../../../src/lib/db/creditBalance";
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
  "creditBalance (postgres) persist/get/getAll/overwrite",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const accountA = `pg-credit-a-${Date.now()}`;
    const accountB = `pg-credit-b-${Date.now()}`;

    try {
      assert.equal(await getPersistedCreditBalance(accountA), null);

      await persistCreditBalance(accountA, 42.5);
      assert.equal(await getPersistedCreditBalance(accountA), 42.5);

      await persistCreditBalance(accountA, 10);
      assert.equal(await getPersistedCreditBalance(accountA), 10, "overwrite should replace value");

      await persistCreditBalance(accountA, 0);
      assert.equal(await getPersistedCreditBalance(accountA), 0, "zero balance must round-trip");

      await persistCreditBalance(accountB, 999);

      const all = await getAllPersistedCreditBalances();
      assert.ok(all instanceof Map);
      assert.equal(all.get(accountA), 0);
      assert.equal(all.get(accountB), 999);
    } finally {
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "antigravityCreditBalance")
        .where("key", "in", [accountA, accountB])
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
