import test from "node:test";
import assert from "node:assert/strict";

import {
  saveEvalRun,
  listEvalRuns,
  listModelEvalRunsForRouting,
  getEvalScorecard,
  listCustomEvalSuites,
  getCustomEvalSuite,
  saveCustomEvalSuite,
  deleteCustomEvalSuite,
} from "../../../src/lib/db/evals";
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
  "evals (postgres) run save/list/routing/scorecard + custom suite CRUD",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const suiteId = `pg-suite-${Date.now()}`;
    const targetId = `pg-model-${Date.now()}`;
    const runGroupId = `pg-group-${Date.now()}`;
    const runIds: string[] = [];
    let customSuiteId: string | null = null;

    try {
      const run1 = await saveEvalRun({
        runGroupId,
        suiteId,
        suiteName: "PG Suite",
        target: { type: "model", id: targetId, label: `Model: ${targetId}` },
        summary: { total: 2, passed: 2, failed: 0, passRate: 100 },
        results: [{ ok: true }],
        avgLatencyMs: 120,
        createdAt: new Date().toISOString(),
      });
      runIds.push(run1.id);
      assert.equal(run1.target.type, "model");
      assert.equal(run1.summary.passRate, 100);

      const listed = await listEvalRuns({ suiteId, limit: 10 });
      assert.ok(listed.some((r) => r.id === run1.id));

      const forRouting = await listModelEvalRunsForRouting({
        targetIds: [targetId],
        suiteIds: [suiteId],
        maxAgeHours: 24,
      });
      assert.ok(forRouting.some((r) => r.id === run1.id));

      const excludedByAge = await listModelEvalRunsForRouting({
        targetIds: [targetId],
        suiteIds: [suiteId],
        maxAgeHours: 0.0000001,
      });
      assert.ok(!excludedByAge.some((r) => r.id === run1.id));

      const scorecard = await getEvalScorecard({ suiteId, limit: 10 });
      assert.ok(scorecard);
      assert.equal(scorecard!.totalCases, 2);

      const savedSuite = await saveCustomEvalSuite({
        name: "PG Custom Suite",
        cases: [
          {
            name: "Case A",
            input: { messages: [{ role: "user", content: "hi" }] },
            expected: { strategy: "contains", value: "hi" },
          },
        ],
      });
      customSuiteId = savedSuite.id;
      assert.equal(savedSuite.cases.length, 1);

      const fetchedSuite = await getCustomEvalSuite(savedSuite.id);
      assert.equal(fetchedSuite!.name, "PG Custom Suite");

      const allSuites = await listCustomEvalSuites();
      assert.ok(allSuites.some((s) => s.id === savedSuite.id));

      const deleted = await deleteCustomEvalSuite(savedSuite.id);
      assert.equal(deleted, true);
      assert.equal(await getCustomEvalSuite(savedSuite.id), null);
      customSuiteId = null;
    } finally {
      for (const id of runIds) {
        await getKyselyDb()
          .deleteFrom("eval_runs")
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
      if (customSuiteId) {
        await getKyselyDb()
          .deleteFrom("eval_cases")
          .where("suite_id", "=", customSuiteId)
          .execute()
          .catch(() => {});
        await getKyselyDb()
          .deleteFrom("eval_suites")
          .where("id", "=", customSuiteId)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
