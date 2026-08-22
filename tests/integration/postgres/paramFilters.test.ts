import test from "node:test";
import assert from "node:assert/strict";

import {
  getParamFilterConfig,
  setParamFilterConfig,
  deleteParamFilterConfig,
  isAutoLearnGloballyEnabled,
  setGlobalAutoLearnEnabled,
  addParamToBlocklist,
  ensureParamFilterCacheLoaded,
} from "../../../src/lib/db/paramFilters";
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
  "paramFilters (postgres) get/set/delete/auto-learn lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();
    await ensureParamFilterCacheLoaded();

    try {
      assert.equal(getParamFilterConfig("openai"), null);

      await setParamFilterConfig("openai", { block: ["logit_bias"], allow: ["seed"] });
      const fetched = getParamFilterConfig("openai");
      assert.deepEqual(fetched?.block, ["logit_bias"]);
      assert.deepEqual(fetched?.allow, ["seed"]);

      await addParamToBlocklist("openai", "top_k");
      assert.deepEqual(getParamFilterConfig("openai")?.block, ["logit_bias", "top_k"]);

      await addParamToBlocklist("openai", "reasoning_effort", "gpt-5");
      const withModel = getParamFilterConfig("openai");
      assert.deepEqual(withModel?.models?.["gpt-5"]?.block, ["reasoning_effort"]);

      assert.equal(isAutoLearnGloballyEnabled(), false);
      await setGlobalAutoLearnEnabled(true);
      assert.equal(isAutoLearnGloballyEnabled(), true);
      await setGlobalAutoLearnEnabled(false);
      assert.equal(isAutoLearnGloballyEnabled(), false);

      await deleteParamFilterConfig("openai");
      assert.equal(getParamFilterConfig("openai"), null);
    } finally {
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "provider_param_filters")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
