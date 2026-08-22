import test from "node:test";
import assert from "node:assert/strict";

import {
  createProxy,
  listProxies,
  getProxyById,
  updateProxy,
  upsertProxy,
  deleteProxyById,
  assignProxyToScope,
  getProxyAssignments,
  getProxyWhereUsed,
  addProxyToScopePool,
  removeProxyFromScopePool,
  getScopeProxyPool,
  setScopeRotationStrategy,
  getScopeRotationStrategy,
  resolveProxyForScopeFromRegistry,
  resolveProxyForConnectionFromRegistry,
  hasBlockingProxyAssignment,
  createProxyAndAssign,
  updateProxyAndAssign,
  getProxyHealthStats,
  bulkAssignProxyToScope,
} from "../../../src/lib/db/proxies";
import { createProviderConnection, deleteProviderConnection } from "../../../src/lib/db/providers";
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
  "proxies (postgres) registry/assignment/pool/rotation/resolution lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const provider = "pg-proxy-provider";
    let connectionId: string | null = null;

    try {
      const proxyA = await createProxy({
        name: "PG Proxy A",
        type: "http",
        host: "pg-proxy-a.local",
        port: 8080,
      });
      assert.ok(proxyA?.id);

      const proxyB = await createProxy({
        name: "PG Proxy B",
        type: "http",
        host: "pg-proxy-b.local",
        port: 8081,
        status: "inactive",
      });
      assert.ok(proxyB?.id);

      const all = await listProxies();
      assert.ok(all.find((p) => p.id === proxyA!.id));

      const fetched = await getProxyById(proxyA!.id as string, { includeSecrets: true });
      assert.equal(fetched?.host, "pg-proxy-a.local");

      const updated = await updateProxy(proxyA!.id as string, { name: "PG Proxy A renamed" });
      assert.equal(updated?.name, "PG Proxy A renamed");

      const upserted = await upsertProxy({
        name: "PG Proxy A upsert",
        type: "http",
        host: "pg-proxy-a.local",
        port: 8080,
      });
      assert.equal(upserted.action, "updated");
      assert.equal(upserted.proxy?.id, proxyA!.id);

      // Single-assignment (replace) semantics on a connection/provider scope.
      connectionId = (
        await createProviderConnection({
          provider,
          authType: "apikey",
          name: "PG Proxy Test Connection",
          apiKey: "sk-pg-proxy-test",
        })
      ).id as string;

      const assignment = await assignProxyToScope("account", connectionId, proxyA!.id as string);
      assert.equal(assignment?.proxyId, proxyA!.id);

      const assignments = await getProxyAssignments({ proxyId: proxyA!.id as string });
      assert.ok(assignments.some((a) => a.scopeId === connectionId));

      const whereUsed = await getProxyWhereUsed(proxyA!.id as string);
      assert.ok(whereUsed.count >= 1);

      const resolvedByConn = await resolveProxyForConnectionFromRegistry(connectionId);
      assert.equal(resolvedByConn?.proxy?.host, "pg-proxy-a.local");

      const resolvedByScope = await resolveProxyForScopeFromRegistry("account", connectionId);
      assert.equal(resolvedByScope?.proxy?.host, "pg-proxy-a.local");

      const blocking = await hasBlockingProxyAssignment(connectionId);
      assert.equal(blocking, false);

      // Pool: add a second (dead) proxy to the same scope; alive-only resolution
      // must keep returning the live member, never the dead one, and the
      // fail-closed guard must not trip while a live member exists.
      await addProxyToScopePool("account", connectionId, proxyB!.id as string);
      const pool = await getScopeProxyPool("account", connectionId);
      assert.equal(pool.length, 2);

      for (let i = 0; i < 5; i++) {
        const r = await resolveProxyForConnectionFromRegistry(connectionId);
        assert.equal(r?.proxy?.host, "pg-proxy-a.local", "dead pool member must never be picked");
      }

      const strategy = await setScopeRotationStrategy("account", connectionId, "random");
      assert.equal(strategy, "random");
      assert.equal(await getScopeRotationStrategy("account", connectionId), "random");

      const removed = await removeProxyFromScopePool("account", connectionId, proxyB!.id as string);
      assert.equal(removed, true);
      assert.equal((await getScopeProxyPool("account", connectionId)).length, 1);

      // createProxyAndAssign / updateProxyAndAssign (transactional path).
      const createdAndAssigned = await createProxyAndAssign(
        {
          name: "PG Proxy C",
          type: "http",
          host: "pg-proxy-c.local",
          port: 8082,
        },
        { scope: "provider", scopeId: provider }
      );
      assert.equal(createdAndAssigned.assignment?.scopeId, provider);

      const updatedAndAssigned = await updateProxyAndAssign(
        createdAndAssigned.proxy!.id as string,
        { name: "PG Proxy C renamed" },
        { scope: "provider", scopeId: provider }
      );
      assert.equal(updatedAndAssigned?.proxy?.name, "PG Proxy C renamed");

      const bulk = await bulkAssignProxyToScope("account", [connectionId], proxyA!.id as string);
      assert.equal(bulk.updated, 1);
      assert.equal(bulk.failed.length, 0);

      const healthStats = await getProxyHealthStats({ hours: 24 });
      assert.ok(Array.isArray(healthStats));

      const deleteBlocked = await deleteProxyById(proxyA!.id as string).catch((e) => e);
      assert.ok(deleteBlocked instanceof Error, "delete must be blocked while still assigned");

      const forceDeleted = await deleteProxyById(proxyA!.id as string, { force: true });
      assert.equal(forceDeleted, true);
      assert.equal(await getProxyById(proxyA!.id as string), null);
    } finally {
      if (connectionId) await deleteProviderConnection(connectionId).catch(() => {});
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("proxy_assignments")
        .where(
          "proxy_id",
          "in",
          kdb.selectFrom("proxy_registry").select("id").where("host", "like", "pg-proxy-%")
        )
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("proxy_scope_rotation")
        .where("scope_id", "=", provider)
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("proxy_registry")
        .where("host", "like", "pg-proxy-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
