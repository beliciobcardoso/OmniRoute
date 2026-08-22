import test from "node:test";
import assert from "node:assert/strict";

import {
  getPoolsByGroup,
  listPools,
  getPool,
  createPool,
  updatePool,
  deletePool,
  upsertAllocations,
  listAllocationsForApiKey,
} from "../../../src/lib/db/quotaPools";
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
  "quotaPools (postgres) full CRUD + allocations + single-provider guard",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const db = getKyselyDb();
    const connA = `pg-conn-a-${Date.now()}`;
    const connB = `pg-conn-b-${Date.now()}`;
    const connOther = `pg-conn-other-${Date.now()}`;
    const apiKeyId = `pg-key-${Date.now()}`;
    const poolIds: string[] = [];

    async function insertConn(id: string, provider: string) {
      await db
        .insertInto("provider_connections")
        .values({
          id,
          provider,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
    }

    try {
      await insertConn(connA, "openai");
      await insertConn(connB, "openai");
      await insertConn(connOther, "anthropic");

      // createPool with multiple connections + initial allocations
      const pool = await createPool({
        connectionId: connA,
        connectionIds: [connA, connB],
        name: "PG Test Pool",
        allocations: [{ apiKeyId, weight: 100, policy: "hard" }],
      });
      poolIds.push(pool.id);
      assert.equal(pool.connectionId, connA);
      assert.deepEqual(pool.connectionIds.sort(), [connA, connB].sort());
      assert.equal(pool.allocations.length, 1);
      assert.equal(pool.groupId, "group-demo");

      // getPool
      const fetched = await getPool(pool.id);
      assert.ok(fetched);
      assert.equal(fetched!.name, "PG Test Pool");

      // listPools / getPoolsByGroup
      const all = await listPools();
      assert.ok(all.some((p) => p.id === pool.id));
      const byGroup = await getPoolsByGroup("group-demo");
      assert.ok(byGroup.some((p) => p.id === pool.id));

      // single-provider guard on createPool
      await assert.rejects(
        () =>
          createPool({
            connectionId: connA,
            connectionIds: [connA, connOther],
            name: "Mixed",
          }),
        /single provider/i
      );

      // updatePool: rename + change allocations
      const updated = await updatePool(pool.id, {
        name: "PG Test Pool Renamed",
        allocations: [{ apiKeyId, weight: 50, policy: "soft" }],
      });
      assert.equal(updated?.name, "PG Test Pool Renamed");
      assert.equal(updated?.allocations[0].policy, "soft");

      // single-provider guard on updatePool
      await assert.rejects(
        () => updatePool(pool.id, { connectionIds: [connA, connOther] }),
        /single provider/i
      );

      // upsertAllocations replaces allocations for the pool
      await upsertAllocations(pool.id, [
        { apiKeyId, weight: 70, policy: "hard" },
        { apiKeyId: `${apiKeyId}-2`, weight: 30, policy: "burst" },
      ]);
      const afterUpsert = await getPool(pool.id);
      assert.equal(afterUpsert?.allocations.length, 2);

      // listAllocationsForApiKey
      const allocsForKey = await listAllocationsForApiKey(apiKeyId);
      assert.ok(allocsForKey.some((a) => a.poolId === pool.id));

      // deletePool
      const deleted = await deletePool(pool.id);
      assert.equal(deleted, true);
      assert.equal(await getPool(pool.id), null);
      assert.equal(await deletePool(pool.id), false);
    } finally {
      for (const id of poolIds) {
        await db
          .deleteFrom("quota_allocations")
          .where("pool_id", "=", id)
          .execute()
          .catch(() => {});
        await db
          .deleteFrom("quota_pool_connections")
          .where("pool_id", "=", id)
          .execute()
          .catch(() => {});
        await db
          .deleteFrom("quota_pools")
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
      await db
        .deleteFrom("provider_connections")
        .where("id", "in", [connA, connB, connOther])
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
