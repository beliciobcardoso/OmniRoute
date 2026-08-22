import test from "node:test";
import assert from "node:assert/strict";

import {
  listSemanticCacheEntries,
  deleteSemanticCacheBySignature,
  deleteSemanticCacheByModel,
} from "../../../src/lib/db/semanticCache";
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
  "semanticCache (postgres) list/search/filter/delete lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const now = new Date().toISOString();
    const kdb = getKyselyDb();

    try {
      await kdb
        .insertInto("semantic_cache")
        .values([
          {
            id: "pg-sc-1",
            signature: "sig-alpha",
            model: "gpt-4",
            prompt_hash: "hash-alpha",
            response: "{}",
            hit_count: 3,
            tokens_saved: 100,
            created_at: now,
            expires_at: now,
          },
          {
            id: "pg-sc-2",
            signature: "sig-beta",
            model: "gpt-4",
            prompt_hash: "hash-beta",
            response: "{}",
            hit_count: 1,
            tokens_saved: 20,
            created_at: now,
            expires_at: now,
          },
          {
            id: "pg-sc-3",
            signature: "sig-gamma",
            model: "claude-3",
            prompt_hash: "hash-gamma",
            response: "{}",
            hit_count: 5,
            tokens_saved: 200,
            created_at: now,
            expires_at: now,
          },
        ])
        .execute();

      const all = await listSemanticCacheEntries({
        page: 1,
        limit: 10,
        search: "",
        model: "",
        sortBy: "created_at",
        sortOrder: "desc",
      });
      assert.equal(all.total, 3);
      assert.equal(all.entries.find((e) => e.signature === "sig-alpha")?.hit_count, 3);

      const byModel = await listSemanticCacheEntries({
        page: 1,
        limit: 10,
        search: "",
        model: "gpt-4",
        sortBy: "created_at",
        sortOrder: "desc",
      });
      assert.equal(byModel.total, 2);

      const bySearch = await listSemanticCacheEntries({
        page: 1,
        limit: 10,
        search: "gamma",
        model: "",
        sortBy: "created_at",
        sortOrder: "desc",
      });
      assert.equal(bySearch.total, 1);
      assert.equal(bySearch.entries[0].signature, "sig-gamma");

      const delBySig = await deleteSemanticCacheBySignature("sig-alpha");
      assert.equal(delBySig.deleted, 1);

      const delByModel = await deleteSemanticCacheByModel("gpt-4");
      assert.equal(delByModel.deleted, 1);

      const remaining = await listSemanticCacheEntries({
        page: 1,
        limit: 10,
        search: "",
        model: "",
        sortBy: "created_at",
        sortOrder: "desc",
      });
      assert.equal(remaining.total, 1);
      assert.equal(remaining.entries[0].signature, "sig-gamma");
    } finally {
      await kdb
        .deleteFrom("semantic_cache")
        .where("id", "like", "pg-sc-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
