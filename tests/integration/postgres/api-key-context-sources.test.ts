import test from "node:test";
import assert from "node:assert/strict";

import {
  getApiKeyContextSource,
  setApiKeyContextSource,
  deleteApiKeyContextSource,
  listApiKeyContextSources,
} from "../../../src/lib/db/apiKeyContextSources";
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
  "apiKeyContextSources (postgres) set/get/upsert/list/delete round trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const apiKeyId = `pg-akcs-${Date.now()}`;

    try {
      assert.equal(await getApiKeyContextSource(apiKeyId, "obsidian"), null);

      await setApiKeyContextSource(apiKeyId, "obsidian", {
        baseUrl: "http://10.0.0.1:27123",
        token: "test-token-123",
        vaultPath: "/test/path",
        enabled: true,
      });

      const result = await getApiKeyContextSource(apiKeyId, "obsidian");
      assert.ok(result);
      assert.equal(result!.baseUrl, "http://10.0.0.1:27123");
      assert.equal(result!.token, "test-token-123");
      assert.equal(result!.vaultPath, "/test/path");
      assert.equal(result!.enabled, true);

      // Partial upsert: only token changes, baseUrl/vaultPath/enabled preserved.
      await setApiKeyContextSource(apiKeyId, "obsidian", { token: "v2" });
      const afterUpsert = await getApiKeyContextSource(apiKeyId, "obsidian");
      assert.equal(afterUpsert!.token, "v2");
      assert.equal(afterUpsert!.baseUrl, "http://10.0.0.1:27123");

      await setApiKeyContextSource(apiKeyId, "notion", { token: "not", enabled: true });
      const listed = await listApiKeyContextSources(apiKeyId);
      assert.equal(listed.length, 2);
      assert.deepEqual(listed.map((s) => s.sourceType).sort(), ["notion", "obsidian"]);

      // Disabling hides it from getApiKeyContextSource (enabled=1 filter).
      await setApiKeyContextSource(apiKeyId, "obsidian", { enabled: false });
      assert.equal(await getApiKeyContextSource(apiKeyId, "obsidian"), null);

      await deleteApiKeyContextSource(apiKeyId, "notion");
      const afterDelete = await listApiKeyContextSources(apiKeyId);
      assert.equal(afterDelete.length, 1);
      assert.equal(afterDelete[0].sourceType, "obsidian");
    } finally {
      await getKyselyDb()
        .deleteFrom("api_key_context_sources")
        .where("api_key_id", "=", apiKeyId)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
