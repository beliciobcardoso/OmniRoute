import test from "node:test";
import assert from "node:assert/strict";

import {
  getCompressionSettings,
  updateCompressionSettings,
  getMcpAccessibilityConfig,
  setMcpAccessibilityConfig,
} from "../../../src/lib/db/compression";
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
  "compression (postgres) settings + mcp-accessibility round-trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const kdb = getKyselyDb();

    try {
      const defaults = await getCompressionSettings();
      assert.equal(defaults.enabled, false);

      const updated = await updateCompressionSettings({
        enabled: true,
        defaultMode: "lite",
        autoTriggerTokens: 12345,
        engines: { rtk: { enabled: true }, caveman: { enabled: false } },
      });
      assert.equal(updated.enabled, true);
      assert.equal(updated.defaultMode, "lite");
      assert.equal(updated.autoTriggerTokens, 12345);
      assert.equal(updated.engines.rtk.enabled, true);
      assert.equal(updated.enginesExplicit, true);

      // Re-read bypasses the 5s TTL cache correctly across repeated updates (upsert path).
      const reUpdated = await updateCompressionSettings({ autoTriggerTokens: 999 });
      assert.equal(reUpdated.autoTriggerTokens, 999);
      assert.equal(reUpdated.defaultMode, "lite", "unrelated fields must survive a partial update");

      const mcpDefault = await getMcpAccessibilityConfig();
      assert.ok(mcpDefault);

      await setMcpAccessibilityConfig({ enabled: false });
      const mcpUpdated = await getMcpAccessibilityConfig();
      assert.equal(mcpUpdated.enabled, false);
    } finally {
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "=", "compression")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
