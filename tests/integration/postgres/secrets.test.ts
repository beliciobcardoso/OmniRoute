import test from "node:test";
import assert from "node:assert/strict";

import { getPersistedSecret, persistSecret } from "../../../src/lib/db/secrets";
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
  "secrets (postgres) persist/read/insert-only lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      assert.equal(await getPersistedSecret("pg-missing-secret"), null);

      await persistSecret("pg-jwt-secret", "first-value");
      assert.equal(await getPersistedSecret("pg-jwt-secret"), "first-value");

      // Insert-only: a second persistSecret for the same key must not overwrite.
      await persistSecret("pg-jwt-secret", "second-value");
      assert.equal(await getPersistedSecret("pg-jwt-secret"), "first-value");
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "=", "secrets")
        .where("key", "like", "pg-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
