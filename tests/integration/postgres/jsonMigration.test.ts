import test from "node:test";
import assert from "node:assert/strict";

import { runJsonMigration } from "../../../src/lib/db/jsonMigration";
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
  "jsonMigration (postgres) runJsonMigration hydrates every entity type, upsert-safe",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();

    const legacyData = {
      providerConnections: [
        {
          id: "pg-jm-conn-1",
          provider: "openai",
          authType: "apikey",
          name: "pg-jm-conn",
          apiKey: "sk-legacy",
          isActive: true,
          rateLimitProtection: true,
        },
      ],
      providerNodes: [{ id: "pg-jm-node-1", type: "openai", name: "pg-jm-node" }],
      combos: [
        {
          id: "pg-jm-combo-usage",
          name: "pg-jm-combo-usage",
          strategy: "usage",
          models: ["openai/gpt-4o-mini"],
          config: { strategy: "context" },
        },
      ],
      apiKeys: [{ id: "pg-jm-key-1", name: "pg-jm-key", key: "sk-key-1", noLog: true }],
      settings: { theme: "dark" },
      usageHistory: [
        {
          id: 900001,
          provider: "openai",
          model: "gpt-4",
          connection_id: "pg-jm-conn-1",
          tokens_input: 10,
          tokens_output: 5,
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ],
      domainCostHistory: [
        {
          id: 900001,
          api_key_id: "pg-jm-key-1",
          cost: 0.5,
          timestamp: Date.parse("2026-05-01T00:00:00.000Z"),
        },
      ],
      domainBudgets: [{ api_key_id: "pg-jm-key-1", daily_limit_usd: 10 }],
    };

    try {
      const counts1 = await runJsonMigration(null, legacyData);
      assert.equal(counts1.connections, 1);
      assert.equal(counts1.nodes, 1);
      assert.equal(counts1.combos, 1);
      assert.equal(counts1.apiKeys, 1);
      assert.equal(counts1.usageHistory, 1);
      assert.equal(counts1.domainCostHistory, 1);
      assert.equal(counts1.domainBudgets, 1);

      // Re-run to verify upsert safety (ON CONFLICT DO UPDATE, not duplicate rows).
      await runJsonMigration(null, legacyData);

      const conn = await kdb
        .selectFrom("provider_connections")
        .selectAll()
        .where("id", "=", "pg-jm-conn-1")
        .executeTakeFirst();
      assert.ok(conn);
      assert.equal(conn.provider, "openai");
      assert.equal(Boolean(conn.is_active), true);
      assert.equal(Boolean(conn.rate_limit_protection), true);

      const node = await kdb
        .selectFrom("provider_nodes")
        .selectAll()
        .where("id", "=", "pg-jm-node-1")
        .executeTakeFirst();
      assert.ok(node);

      const combo = await kdb
        .selectFrom("combos")
        .selectAll()
        .where("id", "=", "pg-jm-combo-usage")
        .executeTakeFirst();
      assert.ok(combo);
      const comboData = JSON.parse(combo.data);
      assert.equal(comboData.strategy, "least-used");
      assert.equal(comboData.config.strategy, "context-optimized");

      const apiKey = await kdb
        .selectFrom("api_keys")
        .selectAll()
        .where("id", "=", "pg-jm-key-1")
        .executeTakeFirst();
      assert.ok(apiKey);
      assert.equal(Boolean(apiKey.no_log), true);

      const kv = await kdb
        .selectFrom("key_value")
        .selectAll()
        .where("namespace", "=", "settings")
        .where("key", "=", "theme")
        .executeTakeFirst();
      assert.ok(kv);
      assert.equal(JSON.parse(kv.value), "dark");

      const usageRows = await kdb
        .selectFrom("usage_history")
        .selectAll()
        .where("connection_id", "=", "pg-jm-conn-1")
        .execute();
      assert.equal(usageRows.length, 1, "upsert must not duplicate the explicit-id row");
      assert.equal(Number(usageRows[0].id), 900001);

      const costRows = await kdb
        .selectFrom("domain_cost_history")
        .selectAll()
        .where("api_key_id", "=", "pg-jm-key-1")
        .execute();
      assert.equal(costRows.length, 1, "upsert must not duplicate the explicit-id row");
      assert.equal(Number(costRows[0].id), 900001);

      const budget = await kdb
        .selectFrom("domain_budgets")
        .selectAll()
        .where("api_key_id", "=", "pg-jm-key-1")
        .executeTakeFirst();
      assert.ok(budget);
      assert.equal(Number(budget.daily_limit_usd), 10);
    } finally {
      await kdb
        .deleteFrom("domain_budgets")
        .where("api_key_id", "=", "pg-jm-key-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("domain_cost_history")
        .where("api_key_id", "=", "pg-jm-key-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("usage_history")
        .where("connection_id", "=", "pg-jm-conn-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "=", "settings")
        .where("key", "=", "theme")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("api_keys")
        .where("id", "=", "pg-jm-key-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("combos")
        .where("id", "=", "pg-jm-combo-usage")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("provider_nodes")
        .where("id", "=", "pg-jm-node-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("provider_connections")
        .where("id", "=", "pg-jm-conn-1")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
