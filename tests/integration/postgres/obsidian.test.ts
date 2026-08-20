import test from "node:test";
import assert from "node:assert/strict";

import {
  getObsidianToken,
  setObsidianToken,
  clearObsidianToken,
  getObsidianBaseUrl,
  setObsidianBaseUrl,
  clearObsidianBaseUrl,
  getObsidianVaultPath,
  setObsidianVaultPath,
  getWebdavUsername,
  setWebdavUsername,
  getWebdavPassword,
  setWebdavPassword,
  getWebdavEnabled,
  setWebdavEnabled,
  getObsidianConfig,
} from "../../../src/lib/db/obsidian";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "obsidian (postgres) key_value CRUD across all settings, upsert overwrite, and defaults",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      await clearObsidianToken();
      await clearObsidianBaseUrl();

      // Defaults when nothing is set.
      assert.equal(await getObsidianToken(), null);
      assert.equal(await getObsidianBaseUrl(), "http://127.0.0.1:27123");
      assert.equal(await getObsidianVaultPath(), null);
      assert.equal(await getWebdavEnabled(), false);

      await setObsidianToken("pg-obsidian-token");
      assert.equal(await getObsidianToken(), "pg-obsidian-token");

      // setObsidianToken/setObsidianBaseUrl use INSERT OR REPLACE (upsert
      // overwrite) semantics, unlike notion's INSERT OR IGNORE — re-setting
      // MUST overwrite.
      await setObsidianToken("pg-obsidian-token-2");
      assert.equal(await getObsidianToken(), "pg-obsidian-token-2");

      await setObsidianBaseUrl("http://10.0.0.5:27123");
      assert.equal(await getObsidianBaseUrl(), "http://10.0.0.5:27123");

      await setObsidianVaultPath("/vaults/pg-test");
      assert.equal(await getObsidianVaultPath(), "/vaults/pg-test");

      await setWebdavUsername("pg-webdav-user");
      assert.equal(await getWebdavUsername(), "pg-webdav-user");

      await setWebdavPassword("pg-webdav-secret");
      assert.equal(await getWebdavPassword(), "pg-webdav-secret");

      await setWebdavEnabled(true);
      assert.equal(await getWebdavEnabled(), true);

      const config = await getObsidianConfig();
      assert.equal(config.connected, true);
      assert.equal(config.token, "pg-obsidian-token-2");
      assert.equal(config.baseUrl, "http://10.0.0.5:27123");
      assert.equal(config.vaultPath, "/vaults/pg-test");

      await clearObsidianToken();
      assert.equal(await getObsidianToken(), null);
      await clearObsidianBaseUrl();
      assert.equal(await getObsidianBaseUrl(), "http://127.0.0.1:27123");
    } finally {
      await clearObsidianToken().catch(() => {});
      await clearObsidianBaseUrl().catch(() => {});
      await resetKyselyDb();
    }
  }
);
