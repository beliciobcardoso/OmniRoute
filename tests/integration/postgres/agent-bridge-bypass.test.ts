import test from "node:test";
import assert from "node:assert/strict";

import {
  getAllBypassPatterns,
  getUserBypassPatterns,
  replaceUserBypassPatterns,
  seedDefaultBypassPatterns,
} from "../../../src/lib/db/agentBridgeBypass";
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
  "agentBridgeBypass (postgres) seed idempotency, replace-in-transaction, and empty-array clear",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const defaults = [`pg-default-${Date.now()}-a`, `pg-default-${Date.now()}-b`];

    try {
      assert.deepEqual(await getAllBypassPatterns(), []);

      await seedDefaultBypassPatterns(defaults);
      // Idempotent — re-seeding must not duplicate (ON CONFLICT DO NOTHING).
      await seedDefaultBypassPatterns(defaults);
      const afterSeed = await getAllBypassPatterns();
      assert.equal(afterSeed.length, defaults.length);
      assert.ok(afterSeed.every((r) => r.source === "default"));

      await replaceUserBypassPatterns(["custom.host.1"]);
      await replaceUserBypassPatterns(["custom.host.2", "custom.host.3"]);
      const userPatterns = await getUserBypassPatterns();
      assert.deepEqual(userPatterns, ["custom.host.2", "custom.host.3"]);

      // Defaults untouched by the user-pattern replace transaction.
      const allAfterReplace = await getAllBypassPatterns();
      assert.equal(allAfterReplace.filter((r) => r.source === "default").length, defaults.length);
      assert.equal(allAfterReplace.filter((r) => r.source === "user").length, 2);

      // Empty array clears all user patterns without touching defaults.
      await replaceUserBypassPatterns([]);
      assert.deepEqual(await getUserBypassPatterns(), []);
      assert.equal((await getAllBypassPatterns()).length, defaults.length);
    } finally {
      await getKyselyDb()
        .deleteFrom("agent_bridge_bypass")
        .where("source", "=", "user")
        .execute()
        .catch(() => {});
      for (const p of defaults) {
        await getKyselyDb()
          .deleteFrom("agent_bridge_bypass")
          .where("pattern", "=", p)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
