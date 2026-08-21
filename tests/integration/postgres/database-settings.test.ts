import test from "node:test";
import assert from "node:assert/strict";

import {
  getUserDatabaseSettings,
  updateDatabaseSettings,
} from "../../../src/lib/db/databaseSettings";
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
 * getUserDatabaseSettings()/updateDatabaseSettings() stay synchronous and use
 * an in-memory cache (see databaseSettings.ts) that is only best-effort
 * persisted to Postgres — read-your-own-write here relies on the optimistic
 * cache update happening before the fire-and-forget Postgres write resolves,
 * so we poll briefly for the underlying row to land.
 */
test(
  "databaseSettings (postgres) updateDatabaseSettings persists user overrides to key_value",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      const before = getUserDatabaseSettings();
      const nextFrequency = before.backup.autoBackupFrequency === "daily" ? "weekly" : "daily";

      const updated = updateDatabaseSettings({
        backup: { autoBackupFrequency: nextFrequency },
      });
      assert.equal(updated.backup.autoBackupFrequency, nextFrequency);

      // Cache read reflects the optimistic update immediately.
      const afterCacheRead = getUserDatabaseSettings();
      assert.equal(afterCacheRead.backup.autoBackupFrequency, nextFrequency);

      // Wait for the fire-and-forget persist to land in Postgres.
      let persisted: { value: string } | undefined;
      for (let attempt = 0; attempt < 20 && !persisted; attempt++) {
        persisted = await getKyselyDb()
          .selectFrom("key_value")
          .select("value")
          .where("namespace", "=", "databaseSettings")
          .where("key", "=", "backup.autoBackupFrequency")
          .executeTakeFirst();
        if (!persisted) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(persisted, "row persisted to Postgres");
      assert.equal(JSON.parse(persisted!.value), nextFrequency);
    } finally {
      // updateDatabaseSettings() persists the full merged settings object (not
      // just the changed field) into the "databaseSettings" namespace — clean
      // up everything it wrote.
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "databaseSettings")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
