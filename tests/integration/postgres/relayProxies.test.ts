import test from "node:test";
import assert from "node:assert/strict";

import {
  createRelayToken,
  getRelayToken,
  getRelayTokens,
  updateRelayToken,
  toggleRelayToken,
  checkRateLimit,
  recordRelayUsage,
  getRelayUsage,
  getRelayLogs,
  deleteRelayToken,
} from "../../../src/lib/db/relayProxies";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "relayProxies (postgres) create/list/rate-limit/usage/logs/delete",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    let tokenId: string | null = null;

    try {
      const created = await createRelayToken({
        name: "PG Relay Token",
        maxRequestsPerMinute: 2,
        maxRequestsPerDay: 1000,
      });
      tokenId = created.id;
      assert.match(created.rawToken, /^relay_/);
      assert.equal(created.enabled, true);
      assert.equal(created.maxRequestsPerMinute, 2);

      const fetched = await getRelayToken(created.id);
      assert.equal(fetched?.name, "PG Relay Token");

      const all = await getRelayTokens();
      assert.ok(all.some((t) => t.id === created.id));

      const updated = await updateRelayToken(created.id, { maxRequestsPerMinute: 5 });
      assert.equal(updated?.maxRequestsPerMinute, 5);

      const toggled = await toggleRelayToken(created.id, false);
      assert.equal(toggled?.enabled, false);
      await toggleRelayToken(created.id, true);

      await recordRelayUsage(created.id, { model: "gpt-4o", cost: 0.5, promptTokens: 10 });
      await recordRelayUsage(created.id, { model: "gpt-4o", cost: 0.5, promptTokens: 10 });

      const rate = await checkRateLimit(created.id);
      assert.equal(rate.allowed, true);
      assert.equal(rate.remaining, 3);

      const usage = await getRelayUsage(created.id, 0);
      assert.equal(usage.requestCount, 2);
      assert.equal(usage.totalCost, 1);

      const logs = await getRelayLogs(created.id, 10);
      assert.equal(logs.length, 2);

      const deleted = await deleteRelayToken(created.id);
      assert.equal(deleted, undefined);
      assert.equal(await getRelayToken(created.id), null);
      tokenId = null;
    } finally {
      if (tokenId) await deleteRelayToken(tokenId).catch(() => {});
      await resetKyselyDb();
    }
  }
);
