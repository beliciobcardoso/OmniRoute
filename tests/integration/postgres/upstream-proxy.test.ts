import test from "node:test";
import assert from "node:assert/strict";

import {
  getUpstreamProxyConfigs,
  getUpstreamProxyConfig,
  upsertUpstreamProxyConfig,
  updateUpstreamProxyConfig,
  deleteUpstreamProxyConfig,
  getProvidersByMode,
  getFallbackChainForProvider,
} from "../../../src/lib/db/upstreamProxy";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "upstreamProxy (postgres) upserts, updates, and reads back config",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const providerId = `pg-provider-${Date.now()}`;

    try {
      const created = await upsertUpstreamProxyConfig({
        providerId,
        mode: "fallback",
        cliproxyapiModelMapping: { "ag/gemini-3-pro": "gemini-3-pro-high" },
        nativePriority: 1,
        cliproxyapiPriority: 2,
        enabled: true,
        family: "gemini",
      });
      assert.equal(created?.providerId, providerId);
      assert.equal(created?.mode, "fallback");
      assert.deepEqual(created?.cliproxyapiModelMapping, {
        "ag/gemini-3-pro": "gemini-3-pro-high",
      });
      assert.equal(created?.enabled, true);
      assert.equal(created?.family, "gemini");

      const fetched = await getUpstreamProxyConfig(providerId);
      assert.equal(fetched?.providerId, providerId);

      // Re-upsert (ON CONFLICT path) — verifies the UNIQUE constraint on
      // provider_id needed for Postgres ON CONFLICT is actually present
      // (bootstrap.sql previously lacked it entirely).
      const reupserted = await upsertUpstreamProxyConfig({
        providerId,
        mode: "cliproxyapi",
        enabled: true,
      });
      assert.equal(reupserted?.mode, "cliproxyapi");

      const all = await getUpstreamProxyConfigs();
      assert.ok(all.some((c) => c.providerId === providerId));

      const byMode = await getProvidersByMode("cliproxyapi");
      assert.ok(byMode.some((c) => c.providerId === providerId));

      const updated = await updateUpstreamProxyConfig(providerId, {
        mode: "fallback",
        nativePriority: 5,
      });
      assert.equal(updated?.mode, "fallback");
      assert.equal(updated?.nativePriority, 5);

      const chain = await getFallbackChainForProvider(providerId);
      assert.equal(chain.length, 2);
      assert.equal(chain[0].executor, "cliproxyapi");
      assert.equal(chain[1].executor, "native");

      await assert.rejects(
        () => updateUpstreamProxyConfig("does-not-exist", { mode: "native" }),
        /not found/i
      );

      assert.equal(await deleteUpstreamProxyConfig(providerId), true);
      assert.equal(await getUpstreamProxyConfig(providerId), null);
      assert.equal(await deleteUpstreamProxyConfig(providerId), false);
    } finally {
      await deleteUpstreamProxyConfig(providerId).catch(() => {});
      await resetKyselyDb();
    }
  }
);
