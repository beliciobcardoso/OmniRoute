import test from "node:test";
import assert from "node:assert/strict";

import { countEncryptedCredentials, resetEncryptedColumns } from "../../../src/lib/db/recovery";
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
  "recovery (postgres) countEncryptedCredentials + resetEncryptedColumns",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();

    try {
      const nowIso = new Date().toISOString();
      await kdb
        .insertInto("provider_connections")
        .values({
          id: "pg-recovery-1",
          provider: "openai",
          name: "pg-recovery-conn",
          api_key: "enc:v1:fake-encrypted-value",
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute();

      const countBefore = await countEncryptedCredentials();
      assert.ok(countBefore >= 1);

      const dryRun = await resetEncryptedColumns({ dryRun: true });
      assert.ok(dryRun.affected >= 1);

      const countAfterDryRun = await countEncryptedCredentials();
      assert.equal(countAfterDryRun, countBefore, "dry run must not mutate rows");

      const forced = await resetEncryptedColumns({ dryRun: false });
      assert.ok(forced.affected >= 1);

      const row = await kdb
        .selectFrom("provider_connections")
        .select(["api_key"])
        .where("id", "=", "pg-recovery-1")
        .executeTakeFirst();
      assert.equal(row?.api_key, null);

      const countAfterReset = await countEncryptedCredentials();
      assert.equal(countAfterReset, 0);
    } finally {
      await kdb
        .deleteFrom("provider_connections")
        .where("id", "=", "pg-recovery-1")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
