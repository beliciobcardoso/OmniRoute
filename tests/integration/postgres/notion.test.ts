import test from "node:test";
import assert from "node:assert/strict";

import {
  getNotionToken,
  setNotionToken,
  clearNotionToken,
  getNotionConfig,
} from "../../../src/lib/db/notion";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "notion (postgres) token set/get/clear roundtrip, and re-set (ON CONFLICT) overwrite",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      await clearNotionToken();
      assert.equal(await getNotionToken(), null);
      const emptyConfig = await getNotionConfig();
      assert.equal(emptyConfig.connected, false);

      await setNotionToken("pg-token-1");
      assert.equal(await getNotionToken(), "pg-token-1");
      const config = await getNotionConfig();
      assert.equal(config.connected, true);
      assert.equal(config.token, "pg-token-1");

      // setNotionToken uses INSERT ... ON CONFLICT DO NOTHING (matches the
      // SQLite "INSERT OR IGNORE" semantics) — re-setting must NOT overwrite.
      await setNotionToken("pg-token-2");
      assert.equal(await getNotionToken(), "pg-token-1");

      await clearNotionToken();
      assert.equal(await getNotionToken(), null);
    } finally {
      await clearNotionToken().catch(() => {});
      await resetKyselyDb();
    }
  }
);
