import test from "node:test";
import assert from "node:assert/strict";

import {
  getFeatureFlagOverride,
  getFeatureFlagOverrides,
  setFeatureFlagOverride,
  removeFeatureFlagOverride,
  clearAllFeatureFlagOverrides,
} from "../../../src/lib/db/featureFlags";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 *
 * getFeatureFlagOverride()/getFeatureFlagOverrides() stay synchronous even in
 * Postgres mode (see the comment in src/lib/db/featureFlags.ts) — they read
 * from an in-memory cache that set/remove/clear update optimistically before
 * firing a background write. This test polls with a short delay to allow
 * that background write to land, so it also exercises the real Postgres
 * round-trip, not just the synchronous cache path.
 */
async function waitForPersisted(key: string, expected: string | undefined, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await getKyselyDb()
      .selectFrom("key_value")
      .select("value")
      .where("namespace", "=", "feature_flags")
      .where("key", "=", key)
      .executeTakeFirst();
    if (expected === undefined ? row === undefined : row?.value === expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${key} to persist as ${expected}`);
}

test(
  "featureFlags (postgres) sync cache reflects writes immediately, background write lands in Postgres",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      // Clean slate — clear any leftover overrides from a prior run.
      clearAllFeatureFlagOverrides();
      await waitForPersisted("REQUIRE_API_KEY", undefined);
      assert.equal(getFeatureFlagOverride("REQUIRE_API_KEY"), undefined);

      // set() is synchronous — the cache reflects the new value immediately,
      // with no await needed by the caller.
      setFeatureFlagOverride("REQUIRE_API_KEY", "true");
      assert.equal(getFeatureFlagOverride("REQUIRE_API_KEY"), "true");

      // The background write must eventually land in the real table too.
      await waitForPersisted("REQUIRE_API_KEY", "true");

      // Enum validation still throws synchronously before touching the DB.
      assert.throws(() => setFeatureFlagOverride("INJECTION_GUARD_MODE", "not-a-real-mode"));
      assert.throws(() => setFeatureFlagOverride("NOT_A_REAL_FLAG", "x"));

      setFeatureFlagOverride("INJECTION_GUARD_MODE", "block");
      const all = getFeatureFlagOverrides();
      assert.equal(all.REQUIRE_API_KEY, "true");
      assert.equal(all.INJECTION_GUARD_MODE, "block");
      await waitForPersisted("INJECTION_GUARD_MODE", "block");

      removeFeatureFlagOverride("REQUIRE_API_KEY");
      assert.equal(getFeatureFlagOverride("REQUIRE_API_KEY"), undefined);
      await waitForPersisted("REQUIRE_API_KEY", undefined);
      // The other override must survive the single-key removal.
      assert.equal(getFeatureFlagOverride("INJECTION_GUARD_MODE"), "block");

      clearAllFeatureFlagOverrides();
      assert.deepEqual(getFeatureFlagOverrides(), {});
      await waitForPersisted("INJECTION_GUARD_MODE", undefined);
    } finally {
      clearAllFeatureFlagOverrides();
      await waitForPersisted("REQUIRE_API_KEY", undefined).catch(() => {});
      await resetKyselyDb();
    }
  }
);
