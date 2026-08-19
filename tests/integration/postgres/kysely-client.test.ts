import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import { getKyselyDb, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — this project doesn't
 * provision one via docker-compose (see docs/architecture/POSTGRES_SUPPORT.md),
 * so point it at any instance you already have. Run locally with e.g.:
 *   DB_DRIVER=postgres DATABASE_URL=postgres://user:pass@localhost:5432/some_db \
 *     node --import tsx/esm --test tests/integration/postgres/kysely-client.test.ts
 * Wired into CI as the `test-postgres-adapter` job (postgres service container).
 */
test(
  "getKyselyDb connects and round-trips a query against real Postgres",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();

    const db = getKyselyDb();
    try {
      const result = await sql<{ one: number }>`select 1 as one`.execute(db);
      assert.equal(result.rows[0]?.one, 1);
    } finally {
      await resetKyselyDb();
    }
  }
);
