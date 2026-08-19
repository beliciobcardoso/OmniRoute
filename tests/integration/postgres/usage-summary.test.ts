import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import { sumUsageTokensThisMonth } from "../../../src/lib/db/usageSummary";
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
  "sumUsageTokensThisMonth (postgres) sums only the current calendar month's rolled-up tokens",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    const db = getKyselyDb();

    try {
      // Table creation goes through the shared, advisory-lock-protected
      // bootstrap rather than an ad hoc CREATE TABLE here — a second,
      // unprotected DDL statement racing the lock-guarded bootstrap (which
      // other test files in this same directory also call concurrently)
      // can hit a duplicate-key error on Postgres's system catalog.
      await ensurePostgresBootstrap();
      await sql`TRUNCATE TABLE daily_usage_summary`.execute(db);

      const thisMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      await db
        .insertInto("daily_usage_summary")
        .values([
          {
            provider: "groq",
            model: "llama",
            date: `${thisMonth}-05`,
            total_input_tokens: 100,
            total_output_tokens: 200,
          },
          {
            provider: "cerebras",
            model: "qwen",
            date: `${thisMonth}-12`,
            total_input_tokens: 50,
            total_output_tokens: 50,
          },
          {
            provider: "groq",
            model: "llama",
            date: "2000-01-01", // long ago — excluded
            total_input_tokens: 9999,
            total_output_tokens: 9999,
          },
        ])
        .execute();

      assert.equal(await sumUsageTokensThisMonth(), 400);
    } finally {
      // Leave the table in place — other integration test files in this
      // directory run concurrently and may depend on it existing (it's
      // part of the shared bootstrap, not owned by this test). Just clear
      // the rows this test inserted.
      await sql`TRUNCATE TABLE daily_usage_summary`.execute(db);
      await resetKyselyDb();
    }
  }
);
