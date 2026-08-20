import test from "node:test";
import assert from "node:assert/strict";

import {
  listOneproxyProxies,
  getOneproxyStats,
  upsertOneproxyProxy,
  getOneproxyProxyById,
  deleteOneproxyProxy,
  clearAllOneproxyProxies,
  getOneproxyProxyForRotation,
  markOneproxyProxyFailed,
} from "../../../src/lib/db/oneproxy";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "oneproxy (postgres) CRUD, stats, rotation, and failure decay",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const ipA = `10.${Date.now() % 250}.1.1`;
    const ipB = `10.${Date.now() % 250}.2.2`;

    try {
      const created = await upsertOneproxyProxy({
        ip: ipA,
        port: 8080,
        protocol: "http",
        countryCode: "US",
        qualityScore: 90,
      });
      assert.equal(created.action, "created");
      assert.equal(created.proxy?.host, ipA);
      assert.equal(created.proxy?.qualityScore, 90);

      const reupserted = await upsertOneproxyProxy({
        ip: ipA,
        port: 8080,
        protocol: "http",
        countryCode: "US",
        qualityScore: 60,
      });
      assert.equal(reupserted.action, "updated");
      assert.equal(reupserted.proxy?.id, created.proxy?.id);
      assert.equal(reupserted.proxy?.qualityScore, 60);

      await upsertOneproxyProxy({
        ip: ipB,
        port: 443,
        protocol: "socks5",
        countryCode: "BR",
        qualityScore: 20,
      });

      const fetched = await getOneproxyProxyById(created.proxy!.id);
      assert.equal(fetched?.host, ipA);

      const httpOnly = await listOneproxyProxies({ protocol: "http" });
      assert.ok(httpOnly.some((p) => p.host === ipA));
      assert.ok(!httpOnly.some((p) => p.host === ipB));

      const highQuality = await listOneproxyProxies({ minQuality: 50 });
      assert.ok(highQuality.some((p) => p.host === ipA));
      assert.ok(!highQuality.some((p) => p.host === ipB));

      const stats = await getOneproxyStats();
      assert.ok(stats.total >= 2);
      assert.ok(stats.byProtocol.some((p) => p.protocol === "http"));
      assert.ok(stats.byCountry.some((c) => c.countryCode === "US"));

      const best = await getOneproxyProxyForRotation({ strategy: "quality" });
      assert.equal(best?.host, ipA);

      // currentQuality (60) > 10, so this only decrements — stays active.
      const failed = await markOneproxyProxyFailed(ipA, 8080);
      assert.equal(failed, true);
      const afterFail = await getOneproxyProxyById(created.proxy!.id);
      assert.equal(afterFail?.qualityScore, 50);
      assert.equal(afterFail?.status, "active");

      const missing = await markOneproxyProxyFailed("192.0.2.254", 65535);
      assert.equal(missing, false);

      assert.equal(await deleteOneproxyProxy(created.proxy!.id), true);
      assert.equal(await getOneproxyProxyById(created.proxy!.id), null);
      assert.equal(await deleteOneproxyProxy(created.proxy!.id), false);

      const cleared = await clearAllOneproxyProxies();
      assert.ok(cleared >= 1);
      assert.equal((await listOneproxyProxies()).length, 0);
    } finally {
      await clearAllOneproxyProxies().catch(() => {});
      await resetKyselyDb();
    }
  }
);
