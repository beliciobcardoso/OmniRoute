import test from "node:test";
import assert from "node:assert/strict";

import {
  getProviderConnections,
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
  clearConnectionErrorIfUnchanged,
  deleteProviderConnection,
  deleteProviderConnections,
  deleteProviderConnectionsByProvider,
  reorderProviderConnections,
  getDistinctGroups,
} from "../../../src/lib/db/providers";
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
  "providers (postgres) create/dedup/update/CAS/reorder/delete lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const provider = "pg-test-provider";

    try {
      // apikey dedup by name, then by decrypted value.
      const created = await createProviderConnection({
        provider,
        authType: "apikey",
        name: "PG Key A",
        apiKey: "sk-pg-secret-1",
        group: "pg-group-1",
      });
      assert.ok(created);
      assert.equal(created!.provider, provider);
      assert.equal(created!.apiKey, "sk-pg-secret-1");
      assert.equal(created!.isActive, true);

      const sameNameUpdate = await createProviderConnection({
        provider,
        authType: "apikey",
        name: "PG Key A",
        apiKey: "sk-pg-secret-1-updated",
      });
      assert.equal(sameNameUpdate!.id, created!.id, "name-based dedup must update, not insert");
      assert.equal(sameNameUpdate!.apiKey, "sk-pg-secret-1-updated");

      const valueDedup = await createProviderConnection({
        provider,
        authType: "apikey",
        name: "", // blank name — must still dedup by decrypted key value (#3023)
        apiKey: "sk-pg-secret-1-updated",
      });
      assert.equal(valueDedup!.id, created!.id, "value-based dedup must update, not insert");

      const second = await createProviderConnection({
        provider,
        authType: "apikey",
        name: "PG Key B",
        apiKey: "sk-pg-secret-2",
      });
      assert.notEqual(second!.id, created!.id);

      const all = await getProviderConnections({ provider });
      assert.equal(all.length, 2, "dedup must not have created extra rows");

      const byGroup = await getDistinctGroups();
      assert.ok(byGroup.includes("pg-group-1"));

      const fetched = await getProviderConnectionById(created!.id as string);
      assert.equal(fetched?.apiKey, "sk-pg-secret-1-updated");

      const updated = await updateProviderConnection(created!.id as string, {
        displayName: "PG Display Name",
        rateLimitProtection: true,
      });
      assert.equal(updated?.displayName, "PG Display Name");
      assert.equal(updated?.rateLimitProtection, true);

      // CAS clear: expected snapshot matches the (unset) current error state → applies.
      const casApplied = await clearConnectionErrorIfUnchanged(created!.id as string, {
        testStatus: undefined,
        lastErrorAt: undefined,
        rateLimitedUntil: undefined,
      });
      assert.equal(casApplied, true);

      // CAS clear again with a stale expected snapshot → must NOT apply (no concurrent
      // write actually happened, but the mismatched expectation should still block it).
      const casBlocked = await clearConnectionErrorIfUnchanged(created!.id as string, {
        testStatus: "some-stale-value",
        lastErrorAt: "2020-01-01T00:00:00.000Z",
        rateLimitedUntil: "2020-01-01T00:00:00.000Z",
      });
      assert.equal(casBlocked, false);

      await updateProviderConnection(second!.id as string, { priority: 1 });
      await reorderProviderConnections(provider);
      const reordered = await getProviderConnections({ provider });
      const priorities = reordered.map((r) => r.priority).sort((a, b) => a - b);
      assert.deepEqual(priorities, [1, 2]);

      // oauth dedup: same email + no username on either side → matches.
      const oauthCreated = await createProviderConnection({
        provider,
        authType: "oauth",
        email: "pg-user@example.com",
        accessToken: "at-1",
      });
      const oauthDeduped = await createProviderConnection({
        provider,
        authType: "oauth",
        email: "pg-user@example.com",
        accessToken: "at-2",
      });
      assert.equal(oauthDeduped!.id, oauthCreated!.id);
      assert.equal(oauthDeduped!.accessToken, "at-2");

      // codex workspace dedup via provider_specific_data JSON path.
      const codexFirst = await createProviderConnection({
        provider: "codex",
        authType: "oauth",
        email: "pg-codex@example.com",
        accessToken: "codex-at-1",
        providerSpecificData: { workspaceId: "ws-pg-1" },
      });
      const codexSameWorkspace = await createProviderConnection({
        provider: "codex",
        authType: "oauth",
        email: "pg-codex@example.com",
        accessToken: "codex-at-2",
        providerSpecificData: { workspaceId: "ws-pg-1" },
      });
      assert.equal(codexSameWorkspace!.id, codexFirst!.id);
      assert.equal(codexSameWorkspace!.accessToken, "codex-at-2");

      const codexDeleted = await deleteProviderConnection(codexFirst!.id as string);
      assert.equal(codexDeleted, true);
      assert.equal(await getProviderConnectionById(codexFirst!.id as string), null);

      const bulkDeleted = await deleteProviderConnections([second!.id as string]);
      assert.equal(bulkDeleted, 1);

      const remainingBeforeCleanup = await getProviderConnections({ provider });
      assert.ok(remainingBeforeCleanup.length >= 1);

      const deletedByProvider = await deleteProviderConnectionsByProvider(provider);
      assert.ok((deletedByProvider ?? 0) >= 1);
      assert.equal((await getProviderConnections({ provider })).length, 0);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("provider_connections")
        .where("provider", "in", [provider, "codex"])
        .where("email", "like", "pg-%@example.com")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("provider_connections")
        .where("provider", "=", provider)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
