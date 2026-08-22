import test from "node:test";
import assert from "node:assert/strict";

import {
  getInterceptionRules,
  setInterceptionRules,
  deleteInterceptionRules,
  resolveInterceptSearch,
  ensureInterceptionRulesCacheLoaded,
} from "../../../src/lib/db/interceptionRules";
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
  "interceptionRules (postgres) get/set/delete/resolve-precedence lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();
    await ensureInterceptionRulesCacheLoaded();

    try {
      assert.equal(getInterceptionRules("anthropic"), null);
      assert.equal(resolveInterceptSearch("anthropic", "claude-3"), undefined);

      await setInterceptionRules("anthropic", {
        interceptSearch: true,
        fetchBackend: "firecrawl",
        models: { "claude-3": { interceptSearch: false } },
      });

      const rules = getInterceptionRules("anthropic");
      assert.equal(rules?.interceptSearch, true);
      assert.equal(rules?.fetchBackend, "firecrawl");

      // Model-level override wins over provider-level default.
      assert.equal(resolveInterceptSearch("anthropic", "claude-3"), false);
      // No model override -> falls back to provider-level default.
      assert.equal(resolveInterceptSearch("anthropic", "claude-4"), true);

      await deleteInterceptionRules("anthropic");
      assert.equal(getInterceptionRules("anthropic"), null);
      assert.equal(resolveInterceptSearch("anthropic", "claude-3"), undefined);
    } finally {
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "interception_rules")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
