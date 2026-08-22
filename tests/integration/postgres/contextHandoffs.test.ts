import test from "node:test";
import assert from "node:assert/strict";

import {
  upsertHandoff,
  getHandoff,
  deleteHandoff,
  hasActiveHandoff,
  cleanupExpiredHandoffs,
  recordSessionModelUsage,
  getLastSessionModel,
  clearSessionModelHistoryForCombo,
} from "../../../src/lib/db/contextHandoffs";
import {
  ensurePostgresBootstrap,
  resetKyselyDb,
  getKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 *
 * Also regression-covers a real bootstrap.sql bug this module's conversion
 * uncovered: context_handoffs.id's DEFAULT was the literal SQLite expression
 * text (a quoted string), not an evaluated Postgres expression — every row
 * would get the exact same id, violating the PRIMARY KEY on the second
 * insert. Inserting 2 distinct handoffs below would fail with a duplicate-key
 * error if that regression reappeared.
 */
test(
  "contextHandoffs (postgres) upsert/get/delete/cleanup + session-model-history lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const sessionA = "pg-handoff-sess-a";
    const sessionB = "pg-handoff-sess-b";
    const comboName = "pg-relay-combo";

    try {
      const base = {
        comboName,
        fromAccount: "account-1",
        summary: "Test summary",
        keyDecisions: ["d1"],
        taskProgress: "50%",
        activeEntities: ["e1"],
        messageCount: 5,
        model: "gpt-4o",
        warningThresholdPct: 0.85,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };

      // Two distinct rows — would collide on a broken id default.
      await upsertHandoff({ ...base, sessionId: sessionA });
      await upsertHandoff({ ...base, sessionId: sessionB, summary: "Second summary" });

      const a = await getHandoff(sessionA, comboName);
      const b = await getHandoff(sessionB, comboName);
      assert.equal(a?.summary, "Test summary");
      assert.equal(b?.summary, "Second summary");
      assert.ok(a?.id && b?.id && a.id !== b.id, "ids must be distinct");

      assert.equal(await hasActiveHandoff(sessionA, comboName), true);

      // Upsert overwrite on (session_id, combo_name) conflict.
      await upsertHandoff({ ...base, sessionId: sessionA, summary: "Updated summary" });
      const updated = await getHandoff(sessionA, comboName);
      assert.equal(updated?.summary, "Updated summary");

      await deleteHandoff(sessionB, comboName);
      assert.equal(await getHandoff(sessionB, comboName), null);

      const expiredSession = "pg-handoff-expired";
      await upsertHandoff({
        ...base,
        sessionId: expiredSession,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      await cleanupExpiredHandoffs();
      assert.equal(await getHandoff(expiredSession, comboName), null);

      // session_model_history
      await recordSessionModelUsage(sessionA, comboName, "openai/gpt-4o", "openai");
      await recordSessionModelUsage(sessionA, comboName, "anthropic/claude", "anthropic");
      assert.equal(await getLastSessionModel(sessionA, comboName), "anthropic/claude");

      const cleared = await clearSessionModelHistoryForCombo(comboName);
      assert.ok(cleared >= 1);
      assert.equal(await getLastSessionModel(sessionA, comboName), null);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("context_handoffs")
        .where("combo_name", "=", comboName)
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("session_model_history")
        .where("combo_name", "=", comboName)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
