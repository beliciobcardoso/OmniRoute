import test from "node:test";
import assert from "node:assert/strict";

import {
  getModelCapabilityOverride,
  setModelCapabilityOverride,
  removeModelCapabilityOverride,
  listModelCapabilityOverrides,
} from "../../../src/lib/db/modelCapabilityOverrides";
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
 * getModelCapabilityOverride()/listModelCapabilityOverrides() stay
 * synchronous and use an in-memory cache (see modelCapabilityOverrides.ts) —
 * read-your-own-write here relies on the optimistic cache update happening
 * synchronously inside set/removeModelCapabilityOverride, before the
 * fire-and-forget Postgres write resolves.
 */
test(
  "modelCapabilityOverrides (postgres) set/get/list/remove round trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const provider = `pg-mco-${Date.now()}`;
    const modelId = "gpt-test";
    const target = `${provider}/${modelId}`;

    try {
      assert.equal(getModelCapabilityOverride(provider, modelId, "max_token"), null);

      const setOk = setModelCapabilityOverride(target, "max_token", 8192);
      assert.equal(setOk, true);
      assert.equal(getModelCapabilityOverride(provider, modelId, "max_token"), 8192);

      const listed = listModelCapabilityOverrides();
      const entry = listed.find((o) => o.provider === provider && o.modelId === modelId);
      assert.ok(entry, "override present in list");
      assert.equal(entry!.value, 8192);

      // Wait for the first fire-and-forget persist to land before issuing a
      // second write — persistPgUpsert() doesn't order concurrent writes to
      // the same key against each other, only against reads (the in-memory
      // cache is always consistent; the underlying Postgres write is not
      // guaranteed to apply in issue order if two writes race).
      let firstPersisted: { override_value: string } | undefined;
      for (let attempt = 0; attempt < 20 && !firstPersisted; attempt++) {
        firstPersisted = await getKyselyDb()
          .selectFrom("model_capability_overrides")
          .select("override_value")
          .where("provider", "=", provider)
          .where("model_id", "=", modelId)
          .where("override_key", "=", "max_token")
          .executeTakeFirst();
        if (!firstPersisted) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(firstPersisted, "initial override persisted to Postgres");
      assert.equal(JSON.parse(firstPersisted!.override_value), 8192);

      // Overwrite.
      setModelCapabilityOverride(target, "max_token", 16384);
      assert.equal(getModelCapabilityOverride(provider, modelId, "max_token"), 16384);

      // Wait for the second fire-and-forget persist to land in Postgres.
      let persisted: { override_value: string } | undefined;
      for (let attempt = 0; attempt < 20 && !persisted; attempt++) {
        persisted = await getKyselyDb()
          .selectFrom("model_capability_overrides")
          .select("override_value")
          .where("provider", "=", provider)
          .where("model_id", "=", modelId)
          .where("override_key", "=", "max_token")
          .executeTakeFirst();
        if (!persisted || JSON.parse(persisted.override_value) !== 16384) {
          persisted = undefined;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      assert.ok(persisted, "override persisted to Postgres with the latest value");

      const removed = removeModelCapabilityOverride(target, "max_token");
      assert.equal(removed, true);
      assert.equal(getModelCapabilityOverride(provider, modelId, "max_token"), null);

      const removedAgain = removeModelCapabilityOverride(target, "max_token");
      assert.equal(removedAgain, false);
    } finally {
      await getKyselyDb()
        .deleteFrom("model_capability_overrides")
        .where("provider", "=", provider)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
