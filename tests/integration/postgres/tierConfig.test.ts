import test from "node:test";
import assert from "node:assert/strict";

import {
  saveTierConfig,
  loadTierConfigFromDb,
  loadTierConfig,
} from "../../../src/lib/db/tierConfig";
import { DEFAULT_TIER_CONFIG } from "../../../open-sse/services/tierConfig";
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
test("tierConfig (postgres) save/load/overwrite", { skip: !process.env.DATABASE_URL }, async () => {
  process.env.DB_DRIVER = "postgres";
  await resetKyselyDb();
  await ensurePostgresBootstrap();

  try {
    assert.equal(await loadTierConfigFromDb(), null);
    assert.deepEqual((await loadTierConfig()).freeProviders, DEFAULT_TIER_CONFIG.freeProviders);

    await saveTierConfig(DEFAULT_TIER_CONFIG);
    const loaded = await loadTierConfigFromDb();
    assert.ok(loaded);
    assert.deepEqual(loaded!.freeProviders, DEFAULT_TIER_CONFIG.freeProviders);

    const modified = { ...DEFAULT_TIER_CONFIG, freeProviders: ["some-other-provider"] };
    await saveTierConfig(modified);
    const loaded2 = await loadTierConfigFromDb();
    assert.deepEqual(loaded2!.freeProviders, ["some-other-provider"]);
  } finally {
    await getKyselyDb()
      .deleteFrom("tier_config")
      .where("key", "=", "tier_config")
      .execute()
      .catch(() => {});
    await resetKyselyDb();
  }
});
