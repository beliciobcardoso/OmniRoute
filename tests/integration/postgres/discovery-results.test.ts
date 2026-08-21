import test from "node:test";
import assert from "node:assert/strict";

import {
  upsertDiscoveryResult,
  getDiscoveryResults,
  getDiscoveryResultById,
  markVerified,
  deleteDiscoveryResult,
} from "../../../src/lib/db/discoveryResults";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "discoveryResults (postgres) upsert-on-conflict, null-endpoint distinctness, verify, and delete",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const providerId = `pg-discover-${Date.now()}`;

    try {
      const created = await upsertDiscoveryResult({
        providerId,
        method: "free_tier",
        authType: "none",
        feasibility: 4,
        riskLevel: "low",
        status: "pending",
        models: ["m1", "m2"],
        endpoint: "https://example.test/api",
      });
      assert.ok(typeof created.id === "number" && created.id > 0);
      assert.deepEqual(created.models, ["m1", "m2"]);

      // Re-upsert same (provider, method, endpoint) → UPDATE, not a new row.
      const updated = await upsertDiscoveryResult({
        providerId,
        method: "free_tier",
        authType: "none",
        feasibility: 5,
        riskLevel: "medium",
        status: "testing",
        endpoint: "https://example.test/api",
      });
      assert.equal(updated.id, created.id);
      assert.equal(updated.feasibility, 5);
      assert.equal(updated.status, "testing");

      // A row with the SAME provider+method but a NULL endpoint must be
      // treated as distinct from the one above (ANSI NULL-is-never-equal-
      // to-NULL semantics, identical in SQLite and Postgres) — not merged
      // into it via ON CONFLICT.
      const nullEndpointRow = await upsertDiscoveryResult({
        providerId,
        method: "free_tier",
        authType: "none",
        feasibility: 1,
        riskLevel: "none",
        status: "pending",
      });
      assert.notEqual(nullEndpointRow.id, created.id);

      const all = await getDiscoveryResults(providerId);
      assert.equal(all.length, 2);

      const found = await getDiscoveryResultById(created.id!);
      assert.equal(found?.providerId, providerId);
      assert.equal(await getDiscoveryResultById(999999999), null);

      const verified = await markVerified(created.id!);
      assert.equal(verified?.status, "verified");
      assert.ok(verified?.verifiedAt);
      assert.equal(await markVerified(999999999), null);

      assert.equal(await deleteDiscoveryResult(created.id!), true);
      assert.equal(await getDiscoveryResultById(created.id!), null);
      assert.equal(await deleteDiscoveryResult(created.id!), false);
    } finally {
      for (const r of await getDiscoveryResults(providerId)) {
        await deleteDiscoveryResult(r.id!).catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
