import test from "node:test";
import assert from "node:assert/strict";

import {
  getAllMiddlewareHooks,
  getEnabledMiddlewareHooks,
  getComboMiddlewareHooks,
  getMiddlewareHook,
  createMiddlewareHook,
  updateMiddlewareHook,
  deleteMiddlewareHook,
  recordHookExecution,
  insertHookLog,
  getHookLogs,
  cleanupHookLogs,
} from "../../../src/lib/db/middleware";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "middleware hooks + logs (postgres) full CRUD lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const globalName = `pg-global-${Date.now()}`;
    const comboId = `combo-${Date.now()}`;
    const scopedName = `pg-scoped-${Date.now()}`;

    try {
      const created = await createMiddlewareHook({
        name: globalName,
        description: "PG global hook",
        priority: 100,
        scope: { type: "global" },
        enabled: true,
        code: "return request;",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
      });
      assert.equal(created.name, globalName);
      assert.equal(created.enabled, true);
      assert.equal(created.runCount, 0);

      await createMiddlewareHook({
        name: scopedName,
        description: "PG combo-scoped hook",
        priority: 50,
        scope: { type: "combo", comboId },
        enabled: true,
        code: "return request;",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
      });

      const all = await getAllMiddlewareHooks();
      assert.ok(all.some((h) => h.name === globalName));
      assert.ok(all.some((h) => h.name === scopedName));

      const enabled = await getEnabledMiddlewareHooks();
      assert.ok(enabled.every((h) => h.enabled));
      assert.ok(enabled.some((h) => h.name === globalName));

      const scopedForCombo = await getComboMiddlewareHooks(comboId);
      assert.ok(
        scopedForCombo.some((h) => h.name === globalName),
        "global hooks always apply"
      );
      assert.ok(scopedForCombo.some((h) => h.name === scopedName));

      const scopedForOtherCombo = await getComboMiddlewareHooks("some-other-combo");
      assert.ok(scopedForOtherCombo.some((h) => h.name === globalName));
      assert.ok(!scopedForOtherCombo.some((h) => h.name === scopedName));

      const updated = await updateMiddlewareHook(globalName, { description: "updated" });
      assert.equal(updated?.description, "updated");

      await recordHookExecution(globalName);
      await recordHookExecution(globalName, "boom");
      const afterExec = await getMiddlewareHook(globalName);
      assert.equal(afterExec?.runCount, 2);
      assert.equal(afterExec?.lastError, "boom");

      await insertHookLog({
        id: `log-${globalName}-1`,
        hookName: globalName,
        requestId: "req-1",
        durationMs: 12,
        mutated: true,
        skipped: false,
        timestamp: new Date().toISOString(),
      });
      await insertHookLog({
        id: `log-${globalName}-2`,
        hookName: globalName,
        requestId: "req-2",
        durationMs: 34,
        mutated: false,
        skipped: true,
        error: "log error",
        timestamp: new Date().toISOString(),
      });

      const logs = await getHookLogs(globalName, 10);
      assert.equal(logs.length, 2);
      assert.ok(logs.every((l) => l.hookName === globalName));
      const withError = logs.find((l) => l.requestId === "req-2");
      assert.equal(withError?.skipped, true);
      assert.equal(withError?.error, "log error");
      const mutatedLog = logs.find((l) => l.requestId === "req-1");
      assert.equal(mutatedLog?.mutated, true);

      const deletedCount = await cleanupHookLogs(1);
      assert.equal(deletedCount, 1);
      const remaining = await getHookLogs(globalName, 10);
      assert.equal(remaining.length, 1);

      assert.equal(await deleteMiddlewareHook(scopedName), true);
      assert.equal(await getMiddlewareHook(scopedName), undefined);
      assert.equal(await deleteMiddlewareHook(scopedName), false);
    } finally {
      await deleteMiddlewareHook(globalName).catch(() => {});
      await deleteMiddlewareHook(scopedName).catch(() => {});
      await resetKyselyDb();
    }
  }
);
