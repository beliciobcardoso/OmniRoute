import test from "node:test";
import assert from "node:assert/strict";

import {
  getVersionManagerStatus,
  getVersionManagerTool,
  upsertVersionManagerTool,
  updateVersionManagerTool,
  updateToolHealth,
  updateToolVersion,
  setToolStatus,
  deleteVersionManagerTool,
  getServiceRow,
  updateServiceField,
} from "../../../src/lib/db/versionManager";
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
  "versionManager (postgres) upsert/update/health/version/status/delete round trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const tool = `pg-tool-${Date.now()}`;

    try {
      const created = await upsertVersionManagerTool({
        tool,
        currentVersion: "1.0.0",
        pid: 4321,
        port: 9001,
        autoUpdate: true,
        autoStart: false,
        configOverrides: { foo: "bar" },
      });
      assert.equal(created.tool, tool);
      assert.equal(created.currentVersion, "1.0.0");
      assert.equal(created.pid, 4321);
      assert.equal(created.port, 9001);
      assert.equal(created.autoUpdate, true);
      assert.equal(created.autoStart, false);
      assert.deepEqual(created.configOverrides, { foo: "bar" });
      assert.equal(typeof created.id, "number");

      // Upsert again — ON CONFLICT(tool) DO UPDATE path.
      const upserted = await upsertVersionManagerTool({ tool, currentVersion: "1.0.1" });
      assert.equal(upserted.currentVersion, "1.0.1");
      assert.equal(upserted.id, created.id, "same row, not a new insert");

      const fetched = await getVersionManagerTool(tool);
      assert.ok(fetched);
      assert.equal(fetched!.currentVersion, "1.0.1");

      const alsoFetched = await getServiceRow(tool);
      assert.equal(alsoFetched!.tool, tool);

      const all = await getVersionManagerStatus();
      assert.ok(all.some((t) => t.tool === tool));

      const updated = await updateVersionManagerTool(tool, {
        status: "running",
        pid: 5555,
        providerExpose: true,
      });
      assert.equal(updated!.status, "running");
      assert.equal(updated!.pid, 5555);
      assert.equal(updated!.providerExpose, true);

      const healthOk = await updateToolHealth(tool, "healthy");
      assert.equal(healthOk, true);
      assert.equal((await getVersionManagerTool(tool))!.healthStatus, "healthy");

      const versionOk = await updateToolVersion(tool, "installed_version", "1.0.1");
      assert.equal(versionOk, true);
      assert.equal((await getVersionManagerTool(tool))!.installedVersion, "1.0.1");

      const statusOk = await setToolStatus(tool, "error", 7777, "boom");
      assert.equal(statusOk, true);
      const afterStatus = await getVersionManagerTool(tool);
      assert.equal(afterStatus!.status, "error");
      assert.equal(afterStatus!.pid, 7777);
      assert.equal(afterStatus!.errorMessage, "boom");

      const fieldUpdated = await updateServiceField(tool, "lastSyncAt", "2026-01-01T00:00:00.000Z");
      assert.equal(fieldUpdated!.lastSyncAt, "2026-01-01T00:00:00.000Z");

      await assert.rejects(() => updateServiceField(tool, "tool", "hacked"));

      const deleted = await deleteVersionManagerTool(tool);
      assert.equal(deleted, true);
      assert.equal(await getVersionManagerTool(tool), null);

      const deletedAgain = await deleteVersionManagerTool(tool);
      assert.equal(deletedAgain, false);
    } finally {
      await getKyselyDb()
        .deleteFrom("version_manager")
        .where("tool", "=", tool)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
