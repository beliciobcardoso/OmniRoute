import test from "node:test";
import assert from "node:assert/strict";

import {
  getSettings,
  updateSettings,
  isCloudEnabled,
  getProxyConfig,
  setProxyForLevel,
  getProxyForLevel,
  deleteProxyForLevel,
  resolveProxyForConnection,
  setProxyConfig,
} from "../../../src/lib/db/settings";
import {
  ensurePostgresBootstrap,
  resetKyselyDb,
  getKyselyDb,
} from "../../../src/lib/db/kysely/client";
import type { SqliteBoolean } from "../../../src/lib/db/kysely/types";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "settings (postgres) settings/proxyConfig/resolveProxyForConnection lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();

    try {
      const initial = await getSettings();
      assert.equal(initial.cloudEnabled, true);
      assert.equal(await isCloudEnabled(), true);

      await updateSettings({ cloudEnabled: false, proxyEnabled: true });
      const updated = await getSettings();
      assert.equal(updated.cloudEnabled, false);
      assert.equal(await isCloudEnabled(), false);

      const emptyProxyConfig = await getProxyConfig();
      assert.equal(emptyProxyConfig.global, null);

      type ProxyRecord = { type: string; host: string; port: number };

      await setProxyForLevel("global", null, { type: "http", host: "10.0.0.1", port: 8080 });
      const globalProxy = (await getProxyForLevel("global")) as ProxyRecord | null;
      assert.equal(globalProxy?.host, "10.0.0.1");

      await setProxyForLevel("provider", "openai", { type: "http", host: "10.0.0.2", port: 9090 });
      const providerProxy = (await getProxyForLevel("provider", "openai")) as ProxyRecord | null;
      assert.equal(providerProxy?.host, "10.0.0.2");

      await deleteProxyForLevel("provider", "openai");
      const deletedProviderProxy = await getProxyForLevel("provider", "openai");
      assert.equal(deletedProviderProxy, null);

      await setProxyConfig({
        level: "combo",
        id: "combo-1",
        proxy: { type: "http", host: "10.0.0.3", port: 7070 },
      });
      const comboProxy = (await getProxyForLevel("combo", "combo-1")) as ProxyRecord | null;
      assert.equal(comboProxy?.host, "10.0.0.3");

      // resolveProxyForConnection: no connection row exists -> falls through to global.
      const resolved = await resolveProxyForConnection("nonexistent-connection");
      assert.equal(resolved.level, "global");
      assert.equal((resolved.proxy as ProxyRecord | null)?.host, "10.0.0.1");

      // Insert a real provider_connections row with proxy_enabled=false: must force "direct".
      await kdb
        .insertInto("provider_connections")
        .values({
          id: "pg-conn-1",
          provider: "openai",
          auth_type: "apikey",
          name: "pg-test-conn",
          proxy_enabled: false as unknown as SqliteBoolean,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
      const resolvedDirect = await resolveProxyForConnection("pg-conn-1");
      assert.equal(resolvedDirect.level, "direct");
      assert.equal(resolvedDirect.proxy, null);
    } finally {
      await kdb
        .deleteFrom("provider_connections")
        .where("id", "=", "pg-conn-1")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "in", ["settings", "proxyConfig"])
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
