import test from "node:test";
import assert from "node:assert/strict";

import {
  createBatch,
  getBatch,
  updateBatch,
  listBatches,
  countBatches,
  getPendingBatches,
  getTerminalBatches,
  ensureBatchItemCheckpoints,
  countBatchItemCheckpoints,
  listBatchItemCheckpoints,
  markBatchItemProcessing,
  markBatchItemResult,
  markBatchItemError,
  deleteBatch,
} from "../../../src/lib/db/batches";
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
  "batches (postgres) create/list/count/checkpoints/delete lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    let batchId: string | null = null;

    try {
      const batch = await createBatch({
        endpoint: "/v1/chat/completions",
        completionWindow: "24h",
        inputFileId: "file_pg_test_input",
        apiKeyId: "pg-test-key",
      });
      batchId = batch.id;
      assert.equal(batch.status, "validating");
      assert.equal(batch.requestCountsTotal, 0);

      const fetched = await getBatch(batch.id);
      assert.equal(fetched?.id, batch.id);

      const updated = await updateBatch(batch.id, {
        status: "in_progress",
        requestCountsTotal: 3,
      });
      assert.equal(updated, true);

      const afterUpdate = await getBatch(batch.id);
      assert.equal(afterUpdate?.status, "in_progress");
      assert.equal(afterUpdate?.requestCountsTotal, 3);

      const pending = await getPendingBatches();
      assert.ok(pending.some((b) => b.id === batch.id));

      await ensureBatchItemCheckpoints(batch.id, [
        { lineNumber: 1, customId: "a" },
        { lineNumber: 2, customId: "b" },
        { lineNumber: 3, customId: "c" },
      ]);

      const checkpointCount = await countBatchItemCheckpoints(batch.id);
      assert.equal(checkpointCount, 3);

      await markBatchItemProcessing(batch.id, { lineNumber: 1, customId: "a" });
      await markBatchItemResult(batch.id, { lineNumber: 1, customId: "a" }, { ok: true });
      await markBatchItemError(batch.id, { lineNumber: 2, customId: "b" }, { message: "boom" });

      const checkpoints = await listBatchItemCheckpoints(batch.id);
      assert.equal(checkpoints.length, 3);
      const cp1 = checkpoints.find((c) => c.lineNumber === 1);
      assert.equal(cp1?.status, "completed");
      assert.deepEqual(cp1?.result, { ok: true });
      const cp2 = checkpoints.find((c) => c.lineNumber === 2);
      assert.equal(cp2?.status, "errored");
      assert.deepEqual(cp2?.error, { message: "boom" });
      const cp3 = checkpoints.find((c) => c.lineNumber === 3);
      assert.equal(cp3?.status, "pending");

      await updateBatch(batch.id, {
        status: "completed",
        completedAt: Math.floor(Date.now() / 1000),
      });
      const terminal = await getTerminalBatches();
      assert.ok(terminal.some((b) => b.id === batch.id));

      const list = await listBatches("pg-test-key", 10);
      assert.ok(list.some((b) => b.id === batch.id));

      const count = await countBatches("pg-test-key");
      assert.equal(count, 1);

      const deleted = await deleteBatch(batch.id);
      assert.equal(deleted, true);
      assert.equal(await getBatch(batch.id), null);
      assert.equal(await countBatchItemCheckpoints(batch.id), 0);
      batchId = null;
    } finally {
      if (batchId) {
        await getKyselyDb()
          .deleteFrom("batch_item_checkpoints")
          .where("batch_id", "=", batchId)
          .execute()
          .catch(() => {});
        await getKyselyDb()
          .deleteFrom("batches")
          .where("id", "=", batchId)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
