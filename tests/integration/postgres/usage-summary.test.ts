import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import { sumUsageTokensThisMonth } from "../../../src/lib/db/usageSummary";
import { getKyselyDb, resetKyselyDb } from "../../../src/lib/db/kysely/client";

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
      await sql`
        CREATE TABLE IF NOT EXISTS daily_usage_summary (
          id SERIAL PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          date TEXT NOT NULL,
          total_requests INTEGER NOT NULL DEFAULT 0,
          total_input_tokens INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER NOT NULL DEFAULT 0,
          total_cost DOUBLE PRECISION NOT NULL DEFAULT 0.0,
          created_at TEXT NOT NULL DEFAULT now()::text
        )
      `.execute(db);
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
      await sql`DROP TABLE IF EXISTS daily_usage_summary`.execute(db);
      await resetKyselyDb();
    }
  }
);
