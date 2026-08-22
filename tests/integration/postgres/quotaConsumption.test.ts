import test from "node:test";
import assert from "node:assert/strict";

import {
  getBucket,
  incrementBucket,
  getPair,
  sumPoolDimension,
  listConsumptionForPool,
  gcOlderThan,
} from "../../../src/lib/db/quotaConsumption";
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
  "quotaConsumption (postgres) bucket read/upsert/pair/aggregate/gc lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const dimKey = "pg-pool:tokens:hourly";
    const now = Date.now();
    const currentBucket = Math.floor(now / 3_600_000);
    const prevBucket = currentBucket - 1;

    try {
      assert.equal(await getBucket("pg-key-1", dimKey, currentBucket), 0);

      await incrementBucket("pg-key-1", dimKey, currentBucket, 40, now);
      await incrementBucket("pg-key-1", dimKey, currentBucket, 10, now);
      assert.equal(await getBucket("pg-key-1", dimKey, currentBucket), 50);

      await incrementBucket("pg-key-1", dimKey, prevBucket, 20, now - 3_600_000);
      await incrementBucket("pg-key-2", dimKey, currentBucket, 5, now);

      const pair = await getPair("pg-key-1", dimKey, currentBucket);
      assert.equal(pair.curr, 50);
      assert.equal(pair.prev, 20);

      const totals = await sumPoolDimension(dimKey, currentBucket);
      assert.equal(totals.currTotal, 55);
      assert.equal(totals.prevTotal, 20);

      const events = await listConsumptionForPool("pg-pool", 10);
      assert.ok(events.some((e) => e.apiKeyId === "pg-key-1" && e.unit === "tokens"));

      await incrementBucket("pg-key-gc", dimKey, 1, 1, now - 1_000_000_000);
      const deleted = await gcOlderThan(now - 1_000);
      assert.ok(deleted >= 1);
      assert.equal(await getBucket("pg-key-gc", dimKey, 1), 0);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("quota_consumption")
        .where("dimension_key", "=", dimKey)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
