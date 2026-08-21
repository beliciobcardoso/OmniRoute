import test from "node:test";
import assert from "node:assert/strict";

import { getProviderCallStats, getModelCallStats } from "../../../src/lib/db/providerStats";
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
  "providerStats (postgres) aggregates totals/success/latency per provider and per model",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const provider = `pg-prov-${Date.now()}`;
    const otherProvider = `pg-prov-other-${Date.now()}`;
    const ids: string[] = [];

    function log(overrides: Record<string, unknown>) {
      const id = `pg-log-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      ids.push(id);
      return {
        id,
        timestamp: new Date().toISOString(),
        model: "openai/gpt-4.1",
        provider,
        status: 200,
        duration: 100,
        tokens_in: 10,
        tokens_out: 20,
        ...overrides,
      };
    }

    try {
      await getKyselyDb()
        .insertInto("call_logs")
        .values([
          log({ status: 200, duration: 100, tokens_in: 10, tokens_out: 20 }),
          log({ status: 500, duration: 300, tokens_in: 5, tokens_out: 0 }),
          log({ provider: otherProvider, status: 200, duration: 50, tokens_in: 1, tokens_out: 2 }),
        ])
        .execute();

      const providerRows = await getProviderCallStats();
      const mine = providerRows.find((r) => r.provider === provider);
      assert.ok(mine, "provider stats present");
      assert.equal(mine!.totalRequests, 2);
      assert.equal(mine!.successfulRequests, 1);
      assert.equal(mine!.avgLatencyMs, 200);
      assert.equal(mine!.totalTokensIn, 15);
      assert.equal(mine!.totalTokensOut, 20);

      const modelRows = await getModelCallStats();
      const m = modelRows.find((r) => r.provider === provider && r.model === "openai/gpt-4.1");
      assert.ok(m, "model row present");
      assert.equal(m!.requests, 2);
      assert.equal(m!.successfulRequests, 1);
    } finally {
      for (const id of ids) {
        await getKyselyDb()
          .deleteFrom("call_logs")
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
