import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";
import { POSTGRES_BOOTSTRAP_TABLES } from "../../../src/lib/db/postgres/tableNames";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "ensurePostgresBootstrap creates all 104 relational tables, idempotently",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    const db = getKyselyDb();

    try {
      const countExpectedTables = async () => {
        const result = await sql<{ count: string }>`
          SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY(${[...POSTGRES_BOOTSTRAP_TABLES]})
        `.execute(db);
        return Number(result.rows[0]?.count);
      };

      await ensurePostgresBootstrap();
      assert.equal(await countExpectedTables(), POSTGRES_BOOTSTRAP_TABLES.length);

      // Idempotent: calling again must not throw or duplicate anything.
      await ensurePostgresBootstrap();
      assert.equal(await countExpectedTables(), POSTGRES_BOOTSTRAP_TABLES.length);
    } finally {
      await resetKyselyDb();
    }
  }
);
