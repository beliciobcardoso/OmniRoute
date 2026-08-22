import test from "node:test";
import assert from "node:assert/strict";

import {
  upsertFreeProxy,
  listFreeProxies,
  countFreeProxies,
  getFreeProxyById,
  markFreeProxyInPool,
  promoteFreeProxyToPool,
  deleteFreeProxy,
  clearFreeProxiesBySource,
  pruneStaleFreeProxies,
  recordFreeProxySync,
  getFreeProxyStats,
  recordFreeProxySyncErrors,
  clearFreeProxySyncErrors,
  getFreeProxySyncErrors,
} from "../../../src/lib/db/freeProxies";
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
  "freeProxies (postgres) upsert/list/count/pool/stats/errors lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      const created = await upsertFreeProxy({
        source: "webshare",
        host: "1.2.3.4",
        port: 8080,
        type: "http",
        countryCode: "us",
        qualityScore: 90,
        latencyMs: 120,
        anonymity: "elite",
        lastValidated: null,
      });
      assert.equal(created.action, "created");

      const updated = await upsertFreeProxy({
        source: "webshare",
        host: "1.2.3.4",
        port: 8080,
        type: "http",
        countryCode: "us",
        qualityScore: 95,
        latencyMs: 100,
        anonymity: "elite",
        lastValidated: null,
      });
      assert.equal(updated.action, "updated");
      assert.equal(updated.id, created.id);

      const fetched = await getFreeProxyById(created.id);
      assert.equal(fetched?.qualityScore, 95);
      assert.equal(fetched?.countryCode, "us");

      const list = await listFreeProxies({ sources: ["webshare"] });
      assert.ok(list.some((p) => p.id === created.id));

      const count = await countFreeProxies({ sources: ["webshare"] });
      assert.equal(count, 1);

      const pruned = await pruneStaleFreeProxies("webshare", new Set<string>());
      assert.equal(pruned, 1);

      const recreated = await upsertFreeProxy({
        source: "webshare",
        host: "5.6.7.8",
        port: 9090,
        type: "socks5",
        countryCode: "de",
        qualityScore: 80,
        latencyMs: 200,
        anonymity: "anonymous",
        lastValidated: null,
      });

      const poolId = await promoteFreeProxyToPool(recreated.id, {
        name: "PG Pool Proxy",
        type: "socks5",
        host: "5.6.7.8",
        port: 9090,
        source: "webshare",
      });
      assert.ok(poolId);

      const afterPromote = await getFreeProxyById(recreated.id);
      assert.equal(afterPromote?.inPool, true);
      assert.equal(afterPromote?.poolProxyId, poolId);

      await markFreeProxyInPool(recreated.id, poolId as string);

      const cleared = await clearFreeProxiesBySource("webshare");
      assert.equal(cleared, 0); // recreated is in_pool=1, so not cleared

      const ts = await recordFreeProxySync("2026-01-01T00:00:00.000Z");
      assert.equal(ts, "2026-01-01T00:00:00.000Z");

      const stats = await getFreeProxyStats();
      assert.equal(stats.lastSyncAt, "2026-01-01T00:00:00.000Z");
      assert.ok(stats.inPool >= 1);

      await recordFreeProxySyncErrors("webshare", ["boom", "retry-later"]);
      const errs = await getFreeProxySyncErrors();
      assert.deepEqual(errs.webshare, ["boom", "retry-later"]);

      await clearFreeProxySyncErrors("webshare");
      const errsAfter = await getFreeProxySyncErrors();
      assert.equal(errsAfter.webshare, undefined);

      const deleted = await deleteFreeProxy(recreated.id);
      assert.equal(deleted, true);
    } finally {
      await getKyselyDb()
        .deleteFrom("proxy_registry")
        .where("source", "=", "webshare")
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("free_proxies")
        .where("source", "=", "webshare")
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("free_proxy_sync_errors")
        .where("source", "=", "webshare")
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", "free_proxies")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
