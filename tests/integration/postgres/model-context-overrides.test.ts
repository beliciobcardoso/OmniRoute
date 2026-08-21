import test from "node:test";
import assert from "node:assert/strict";

import {
  getModelContextOverride,
  getModelContextOverrideRecord,
  setModelContextOverride,
  removeModelContextOverride,
  listModelContextOverrides,
} from "../../../src/lib/db/modelContextOverrides";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 *
 * getModelContextOverride() stays synchronous and uses an in-memory cache
 * (see modelContextOverrides.ts) — read-your-own-write here relies on the
 * optimistic cache update happening synchronously inside
 * set/removeModelContextOverride, before the fire-and-forget Postgres write
 * resolves.
 */
test(
  "modelContextOverrides (postgres) set/get/list/remove round trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const provider = `pg-mcto-${Date.now()}`;
    const modelId = "context-test-model";

    try {
      assert.equal(getModelContextOverride(provider, modelId), null);
      assert.equal(getModelContextOverrideRecord(provider, modelId), null);

      const setOk = setModelContextOverride(provider, modelId, 200_000, "auto:discovery");
      assert.equal(setOk, true);
      assert.equal(getModelContextOverride(provider, modelId), 200_000);

      const record = getModelContextOverrideRecord(provider, modelId);
      assert.ok(record);
      assert.equal(record!.source, "auto:discovery");

      const listed = listModelContextOverrides();
      assert.ok(listed.some((o) => o.provider === provider && o.modelId === modelId));

      // Wait for the fire-and-forget persist to land in Postgres.
      let persisted: { real_context: string } | undefined;
      for (let attempt = 0; attempt < 20 && !persisted; attempt++) {
        persisted = await getKyselyDb()
          .selectFrom("model_context_overrides")
          .select("real_context")
          .where("provider", "=", provider)
          .where("model_id", "=", modelId)
          .executeTakeFirst();
        if (!persisted) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(persisted, "override persisted to Postgres");
      assert.equal(Number(persisted!.real_context), 200_000);

      const removed = removeModelContextOverride(provider, modelId);
      assert.equal(removed, true);
      assert.equal(getModelContextOverride(provider, modelId), null);

      const removedAgain = removeModelContextOverride(provider, modelId);
      assert.equal(removedAgain, false);
    } finally {
      await getKyselyDb()
        .deleteFrom("model_context_overrides")
        .where("provider", "=", provider)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
