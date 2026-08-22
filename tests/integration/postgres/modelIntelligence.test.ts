import test from "node:test";
import assert from "node:assert/strict";

import {
  upsertModelIntelligence,
  deleteModelIntelligence,
  deleteExpiredIntelligence,
  deleteModelIntelligenceBySource,
  listModelIntelligence,
  bulkUpsertModelIntelligence,
  setUserFitnessOverrideEntry,
  deleteUserFitnessOverrideEntry,
} from "../../../src/lib/db/modelIntelligence";
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
  "modelIntelligence (postgres) write-path lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const model = "pg-test-model";

    try {
      await upsertModelIntelligence({
        model,
        source: "arena_elo",
        category: "coding",
        score: 0.75,
        eloRaw: 1400,
        confidence: "high",
        expiresAt: null,
      });
      // Upsert must overwrite on conflict, not duplicate.
      await upsertModelIntelligence({
        model,
        source: "arena_elo",
        category: "coding",
        score: 0.8,
        eloRaw: 1450,
        confidence: "high",
        expiresAt: null,
      });

      const list = await listModelIntelligence({ source: "arena_elo" });
      const matches = list.filter((e) => e.model === model);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].score, 0.8);

      await setUserFitnessOverrideEntry(model, "coding", 0.95);
      const overrides = await listModelIntelligence({ source: "user_override" });
      assert.ok(overrides.some((e) => e.model === model && e.score === 0.95));

      const deletedOverride = await deleteUserFitnessOverrideEntry(model, "coding");
      assert.equal(deletedOverride, true);

      const past = new Date(Date.now() - 60_000).toISOString();
      await upsertModelIntelligence({
        model: "pg-expired-model",
        source: "arena_elo",
        category: "coding",
        score: 0.5,
        eloRaw: null,
        confidence: null,
        expiresAt: past,
      });
      const expiredDeleted = await deleteExpiredIntelligence("arena_elo");
      assert.ok(expiredDeleted >= 1);

      await bulkUpsertModelIntelligence([
        {
          model: "pg-bulk-1",
          source: "models_dev_tier",
          category: "coding",
          score: 0.6,
          eloRaw: null,
          confidence: null,
          expiresAt: null,
        },
        {
          model: "pg-bulk-2",
          source: "models_dev_tier",
          category: "coding",
          score: 0.7,
          eloRaw: null,
          confidence: null,
          expiresAt: null,
        },
      ]);
      const bulkList = await listModelIntelligence({ source: "models_dev_tier" });
      assert.ok(bulkList.some((e) => e.model === "pg-bulk-1"));
      assert.ok(bulkList.some((e) => e.model === "pg-bulk-2"));

      const deletedDirect = await deleteModelIntelligence(model, "arena_elo", "coding");
      assert.equal(deletedDirect, true);

      const bySourceDeleted = await deleteModelIntelligenceBySource("models_dev_tier");
      assert.ok(bySourceDeleted >= 2);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("model_intelligence")
        .where("model", "like", "pg-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
