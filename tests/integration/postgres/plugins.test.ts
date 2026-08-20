import test from "node:test";
import assert from "node:assert/strict";

import {
  insertPlugin,
  getPluginById,
  getPluginByName,
  listPlugins,
  updatePluginStatus,
  updatePluginConfig,
  deletePlugin,
  pluginExists,
  recordPluginExecution,
  getPluginAnalytics,
  getPluginAnalyticsSummary,
} from "../../../src/lib/db/plugins";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "plugins (postgres) CRUD, status/activated_at semantics, config update, and analytics aggregation",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const name = `pg-plugin-${Date.now()}`;
    const id = `pg-plugin-id-${Date.now()}`;

    try {
      assert.equal(await pluginExists(name), false);

      const created = await insertPlugin({
        id,
        name,
        version: "1.0.0",
        main: "index.js",
        manifest: { name, version: "1.0.0" },
        pluginDir: "/tmp/pg-plugin",
      });
      assert.equal(created.name, name);
      assert.equal(created.status, "installed");
      assert.equal(created.enabled, 0);

      assert.equal(await pluginExists(name), true);

      const byId = await getPluginById(id);
      assert.equal(byId?.name, name);
      const byName = await getPluginByName(name);
      assert.equal(byName?.id, id);

      const all = await listPlugins();
      assert.ok(all.some((p) => p.id === id));
      const installedOnly = await listPlugins("installed");
      assert.ok(installedOnly.some((p) => p.id === id));
      const activeOnly = await listPlugins("active");
      assert.ok(!activeOnly.some((p) => p.id === id));

      // Activate → activated_at gets set.
      assert.equal(await updatePluginStatus(name, "active"), true);
      const activated = await getPluginByName(name);
      assert.equal(activated?.status, "active");
      assert.equal(activated?.enabled, 1);
      assert.ok(activated?.activatedAt);
      const firstActivatedAt = activated!.activatedAt;

      // Deactivate → activated_at must be PRESERVED (last-activated-at semantics),
      // not cleared, matching the SQLite COALESCE(?, activated_at) behavior.
      assert.equal(await updatePluginStatus(name, "inactive"), true);
      const deactivated = await getPluginByName(name);
      assert.equal(deactivated?.status, "inactive");
      assert.equal(deactivated?.enabled, 0);
      assert.equal(deactivated?.activatedAt, firstActivatedAt);

      assert.equal(await updatePluginConfig(name, { foo: "bar" }), true);
      const configured = await getPluginByName(name);
      assert.deepEqual(JSON.parse(configured!.config), { foo: "bar" });

      assert.equal(await updatePluginStatus("no-such-plugin", "active"), false);
      assert.equal(await updatePluginConfig("no-such-plugin", {}), false);

      // Analytics
      await recordPluginExecution(name, "onRequest", 12, true);
      await recordPluginExecution(name, "onRequest", 8, true);
      await recordPluginExecution(name, "onRequest", 20, false, "boom");

      const rows = await getPluginAnalytics(name);
      assert.equal(rows.length, 3);
      assert.equal(rows[0].pluginName, name);
      assert.ok(rows.some((r) => r.success === false && r.errorMessage === "boom"));

      const summary = await getPluginAnalyticsSummary(name);
      assert.equal(summary.totalCalls, 3);
      assert.equal(summary.successCount, 2);
      assert.equal(summary.failureCount, 1);
      assert.ok(summary.avgDurationMs > 0);

      assert.equal(await deletePlugin(name), true);
      assert.equal(await getPluginByName(name), null);
      assert.equal(await deletePlugin(name), false);
    } finally {
      await deletePlugin(name).catch(() => {});
      await resetKyselyDb();
    }
  }
);
