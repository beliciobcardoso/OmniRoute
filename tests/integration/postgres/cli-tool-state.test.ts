import test from "node:test";
import assert from "node:assert/strict";

import {
  saveCliToolLastConfigured,
  getCliToolLastConfigured,
  getAllCliToolLastConfigured,
  deleteCliToolLastConfigured,
  saveCliToolInitialConfig,
  getCliToolInitialConfig,
  deleteCliToolInitialConfig,
} from "../../../src/lib/db/cliToolState";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

async function waitForPersisted(
  namespace: string,
  key: string,
  expected: string | undefined,
  timeoutMs = 3000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await getKyselyDb()
      .selectFrom("key_value")
      .select("value")
      .where("namespace", "=", namespace)
      .where("key", "=", key)
      .executeTakeFirst();
    if (expected === undefined ? row === undefined : row?.value === expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${namespace}/${key} to persist as ${expected}`);
}

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 *
 * All 7 exports stay synchronous even in Postgres mode (see the comment in
 * src/lib/db/cliToolState.ts) — reads hit an in-memory cache that writes
 * update optimistically before firing a background persist. This test polls
 * for that background write to confirm the real Postgres round-trip, not
 * just the synchronous cache path.
 */
test(
  "cliToolState (postgres) sync cache reflects writes immediately, background write lands in Postgres",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const toolId = `pg-tool-${Date.now()}`;

    try {
      assert.equal(getCliToolLastConfigured(toolId), null);

      const ts = "2026-01-01T00:00:00.000Z";
      saveCliToolLastConfigured(toolId, ts);
      assert.equal(getCliToolLastConfigured(toolId), ts);
      await waitForPersisted("cliToolLastConfig", toolId, JSON.stringify(ts));

      const all = getAllCliToolLastConfigured();
      assert.equal(all[toolId], ts);

      deleteCliToolLastConfigured(toolId);
      assert.equal(getCliToolLastConfigured(toolId), null);
      await waitForPersisted("cliToolLastConfig", toolId, undefined);

      // Initial config snapshot — first save succeeds, second is a no-op.
      assert.equal(getCliToolInitialConfig(toolId), null);
      const saved = saveCliToolInitialConfig(toolId, { apiKey: "sk-original" });
      assert.equal(saved, true);
      assert.deepEqual(getCliToolInitialConfig(toolId), { apiKey: "sk-original" });
      await waitForPersisted(
        "cliToolInitialConfig",
        toolId,
        JSON.stringify({ apiKey: "sk-original" })
      );

      const savedAgain = saveCliToolInitialConfig(toolId, { apiKey: "sk-should-not-overwrite" });
      assert.equal(savedAgain, false);
      assert.deepEqual(getCliToolInitialConfig(toolId), { apiKey: "sk-original" });

      deleteCliToolInitialConfig(toolId);
      assert.equal(getCliToolInitialConfig(toolId), null);
      await waitForPersisted("cliToolInitialConfig", toolId, undefined);
    } finally {
      deleteCliToolLastConfigured(toolId);
      deleteCliToolInitialConfig(toolId);
      await waitForPersisted("cliToolLastConfig", toolId, undefined).catch(() => {});
      await waitForPersisted("cliToolInitialConfig", toolId, undefined).catch(() => {});
      await resetKyselyDb();
    }
  }
);
