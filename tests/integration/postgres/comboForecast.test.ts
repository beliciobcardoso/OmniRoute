import test from "node:test";
import assert from "node:assert/strict";
import { v4 as uuidv4 } from "uuid";

import { getComboForecastUsageRows } from "../../../src/lib/db/comboForecast";
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
  "comboForecast (postgres) aggregates call_logs by combo/provider/model",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const comboName = `pg-combo-${Date.now()}`;
    const rowIds: string[] = [];
    const baseTime = new Date();

    function makeRow(overrides: Partial<Record<string, unknown>>) {
      const id = uuidv4();
      rowIds.push(id);
      return {
        id,
        timestamp: baseTime.toISOString(),
        status: 200,
        model: "gpt-4o",
        provider: "openai",
        requested_model: "gpt-4o",
        connection_id: "conn-1",
        combo_name: comboName,
        combo_step_id: "step-1",
        combo_execution_key: "exec-1",
        duration: 100,
        tokens_in: 10,
        tokens_out: 20,
        tokens_cache_read: 0,
        tokens_cache_creation: 0,
        tokens_reasoning: 0,
        ...overrides,
      };
    }

    try {
      await getKyselyDb()
        .insertInto("call_logs")
        .values([
          makeRow({}),
          makeRow({ duration: 200, tokens_in: 30, tokens_out: 40 }),
          makeRow({ status: 500, duration: 50, tokens_in: 5, tokens_out: 0 }),
        ])
        .execute();

      const since = new Date(baseTime.getTime() - 60_000).toISOString();
      const rows = await getComboForecastUsageRows({ since, comboName });

      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.comboName, comboName);
      assert.equal(row.provider, "openai");
      assert.equal(row.model, "gpt-4o");
      assert.equal(row.executionKey, "exec-1");
      assert.equal(row.stepId, "step-1");
      assert.equal(row.requests, 3);
      assert.equal(row.successCount, 2);
      assert.equal(row.inputTokens, 45);
      assert.equal(row.outputTokens, 60);
      assert.equal(row.totalTokens, 105);
      assert.equal(row.avgLatencyMs, (100 + 200 + 50) / 3);
    } finally {
      await getKyselyDb()
        .deleteFrom("call_logs")
        .where("id", "in", rowIds)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
