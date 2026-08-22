import { getDbInstance, rowToCamel, objToSnake } from "./core";
import { deleteFile } from "./files";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";
import { v4 as uuidv4 } from "uuid";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// Postgres BIGINT/INTEGER columns come back as JS strings from node-postgres
// for some numeric columns; coerceNum below already defends against that for
// batch date fields. checkpoint numeric fields need the same treatment.
function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseBatchRow(row: any): BatchRecord {
  const camel = rowToCamel(row) as any;
  if (camel.metadata && typeof camel.metadata === "string") {
    try {
      camel.metadata = JSON.parse(camel.metadata);
    } catch {
      camel.metadata = null;
    }
  }
  if (camel.errors && typeof camel.errors === "string") {
    try {
      camel.errors = JSON.parse(camel.errors);
    } catch {
      camel.errors = null;
    }
  }
  if (camel.usage && typeof camel.usage === "string") {
    try {
      camel.usage = JSON.parse(camel.usage);
    } catch {
      camel.usage = null;
    }
  }
  // Normalize numeric date fields to ensure they are valid numbers
  const coerceNum = (v: any): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  camel.createdAt = coerceNum(camel.createdAt) ?? 0;
  camel.inProgressAt = coerceNum(camel.inProgressAt);
  camel.expiresAt = coerceNum(camel.expiresAt);
  camel.finalizingAt = coerceNum(camel.finalizingAt);
  camel.completedAt = coerceNum(camel.completedAt);
  camel.failedAt = coerceNum(camel.failedAt);
  camel.expiredAt = coerceNum(camel.expiredAt);
  camel.cancellingAt = coerceNum(camel.cancellingAt);
  camel.cancelledAt = coerceNum(camel.cancelledAt);
  camel.requestCountsTotal = toInt(camel.requestCountsTotal);
  camel.requestCountsCompleted = toInt(camel.requestCountsCompleted);
  camel.requestCountsFailed = toInt(camel.requestCountsFailed);
  return camel as BatchRecord;
}

export interface BatchRecord {
  id: string;
  endpoint: string;
  completionWindow: string;
  status:
    | "validating"
    | "failed"
    | "in_progress"
    | "finalizing"
    | "completed"
    | "expired"
    | "cancelling"
    | "cancelled";
  inputFileId: string;
  outputFileId?: string | null;
  errorFileId?: string | null;
  createdAt: number;
  inProgressAt?: number | null;
  expiresAt?: number | null;
  finalizingAt?: number | null;
  completedAt?: number | null;
  failedAt?: number | null;
  expiredAt?: number | null;
  cancellingAt?: number | null;
  cancelledAt?: number | null;
  requestCountsTotal: number;
  requestCountsCompleted: number;
  requestCountsFailed: number;
  metadata?: Record<string, any> | null;
  apiKeyId?: string | null;
  errors?: any | null;
  model?: string | null;
  usage?: any | null;
  outputExpiresAfterSeconds?: number | null;
  outputExpiresAfterAnchor?: string | null;
}

export type BatchItemCheckpointStatus = "pending" | "processing" | "completed" | "errored";

export interface BatchItemCheckpoint {
  batchId: string;
  lineNumber: number;
  customId: string | null;
  status: BatchItemCheckpointStatus;
  result: any | null;
  error: any | null;
  createdAt: number;
  updatedAt: number;
}

function parseJsonColumn(value: unknown): any | null {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseBatchItemCheckpoint(row: any): BatchItemCheckpoint {
  return {
    batchId: row.batch_id,
    lineNumber: toInt(row.line_number),
    customId: row.custom_id ?? null,
    status: row.status,
    result: parseJsonColumn(row.result_json),
    error: parseJsonColumn(row.error_json),
    createdAt: toInt(row.created_at),
    updatedAt: toInt(row.updated_at),
  };
}

export async function createBatch(
  batch: Omit<
    BatchRecord,
    | "id"
    | "createdAt"
    | "requestCountsTotal"
    | "requestCountsCompleted"
    | "requestCountsFailed"
    | "status"
  > & { status?: BatchRecord["status"] }
): Promise<BatchRecord> {
  const id = "batch_" + uuidv4().replaceAll("-", "").substring(0, 24);
  const createdAt = Math.floor(Date.now() / 1000);
  const record: BatchRecord = {
    ...batch,
    id,
    createdAt,
    status: batch.status || "validating",
    requestCountsTotal: 0,
    requestCountsCompleted: 0,
    requestCountsFailed: 0,
    errors: batch.errors || null,
    model: batch.model || null,
    usage: batch.usage || null,
    outputExpiresAfterSeconds: batch.outputExpiresAfterSeconds || null,
    outputExpiresAfterAnchor: batch.outputExpiresAfterAnchor || null,
  };

  const snakeRecord = objToSnake({
    ...record,
    metadata: record.metadata ? JSON.stringify(record.metadata) : null,
    errors: record.errors ? JSON.stringify(record.errors) : null,
    usage: record.usage ? JSON.stringify(record.usage) : null,
  }) as any;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb().insertInto("batches").values(snakeRecord).execute();
    return record;
  }

  const db = getDbInstance();
  const keys = Object.keys(snakeRecord);
  const values = Object.values(snakeRecord);
  const placeholders = keys.map(() => "?").join(", ");

  db.prepare(`INSERT INTO batches (${keys.join(", ")}) VALUES (${placeholders})`).run(...values);

  return record;
}

export async function getBatch(id: string): Promise<BatchRecord | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("batches")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? parseBatchRow(row) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM batches WHERE id = ?").get(id);
  if (!row) return null;
  return parseBatchRow(row);
}

export async function updateBatch(id: string, updates: Partial<BatchRecord>): Promise<boolean> {
  const snakeUpdates = objToSnake(updates) as any;
  if (snakeUpdates.metadata && typeof snakeUpdates.metadata !== "string") {
    snakeUpdates.metadata = JSON.stringify(snakeUpdates.metadata);
  }
  if (snakeUpdates.errors && typeof snakeUpdates.errors !== "string") {
    snakeUpdates.errors = JSON.stringify(snakeUpdates.errors);
  }
  if (snakeUpdates.usage && typeof snakeUpdates.usage !== "string") {
    snakeUpdates.usage = JSON.stringify(snakeUpdates.usage);
  }

  const keys = Object.keys(snakeUpdates);
  if (keys.length === 0) return false;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .updateTable("batches")
      .set(snakeUpdates)
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  const db = getDbInstance();
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = Object.values(snakeUpdates);

  const result = db.prepare(`UPDATE batches SET ${setClause} WHERE id = ?`).run(...values, id);
  return result.changes > 0;
}

export async function ensureBatchItemCheckpoints(
  batchId: string,
  items: Array<{ lineNumber: number; customId: string | null }>
): Promise<void> {
  if (items.length === 0) return;

  const now = Math.floor(Date.now() / 1000);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("batch_item_checkpoints")
      .values(
        items.map((item) => ({
          batch_id: batchId,
          line_number: item.lineNumber,
          custom_id: item.customId,
          status: "pending",
          result_json: null,
          error_json: null,
          created_at: now,
          updated_at: now,
        }))
      )
      .onConflict((oc) => oc.columns(["batch_id", "line_number"]).doNothing())
      .execute();
    return;
  }

  const db = getDbInstance();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO batch_item_checkpoints (
      batch_id,
      line_number,
      custom_id,
      status,
      result_json,
      error_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const item of items) {
      insert.run(batchId, item.lineNumber, item.customId, now, now);
    }
  });
  tx();
}

export async function countBatchItemCheckpoints(batchId: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("batch_item_checkpoints")
      .select((eb) => eb.fn.countAll().as("c"))
      .where("batch_id", "=", batchId)
      .executeTakeFirst();
    return row ? toInt(row.c) : 0;
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM batch_item_checkpoints WHERE batch_id = ?")
    .get(batchId) as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

export async function listBatchItemCheckpoints(batchId: string): Promise<BatchItemCheckpoint[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("batch_item_checkpoints")
      .select([
        "batch_id",
        "line_number",
        "custom_id",
        "status",
        "result_json",
        "error_json",
        "created_at",
        "updated_at",
      ])
      .where("batch_id", "=", batchId)
      .orderBy("line_number", "asc")
      .execute();
    return rows.map((row) => parseBatchItemCheckpoint(row));
  }

  const db = getDbInstance();
  const rows = db
    .prepare(
      `
      SELECT batch_id, line_number, custom_id, status, result_json, error_json, created_at, updated_at
      FROM batch_item_checkpoints
      WHERE batch_id = ?
      ORDER BY line_number ASC
    `
    )
    .all(batchId);
  return rows.map((row) => parseBatchItemCheckpoint(row));
}

export async function markBatchItemProcessing(
  batchId: string,
  item: { lineNumber: number; customId: string | null }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("batch_item_checkpoints")
      .values({
        batch_id: batchId,
        line_number: item.lineNumber,
        custom_id: item.customId,
        status: "processing",
        result_json: null,
        error_json: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["batch_id", "line_number"]).doUpdateSet({
          custom_id: item.customId,
          status: "processing",
          result_json: null,
          error_json: null,
          updated_at: now,
        })
      )
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `
    INSERT INTO batch_item_checkpoints (
      batch_id,
      line_number,
      custom_id,
      status,
      result_json,
      error_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'processing', NULL, NULL, ?, ?)
    ON CONFLICT(batch_id, line_number) DO UPDATE SET
      custom_id = excluded.custom_id,
      status = 'processing',
      result_json = NULL,
      error_json = NULL,
      updated_at = excluded.updated_at
  `
  ).run(batchId, item.lineNumber, item.customId, now, now);
}

export async function markBatchItemResult(
  batchId: string,
  item: { lineNumber: number; customId: string | null },
  result: any
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const resultJson = JSON.stringify(result);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("batch_item_checkpoints")
      .set({
        custom_id: item.customId,
        status: "completed",
        result_json: resultJson,
        error_json: null,
        updated_at: now,
      })
      .where("batch_id", "=", batchId)
      .where("line_number", "=", item.lineNumber)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `
    UPDATE batch_item_checkpoints
    SET custom_id = ?,
        status = 'completed',
        result_json = ?,
        error_json = NULL,
        updated_at = ?
    WHERE batch_id = ? AND line_number = ?
  `
  ).run(item.customId, resultJson, now, batchId, item.lineNumber);
}

export async function markBatchItemError(
  batchId: string,
  item: { lineNumber: number; customId: string | null },
  error: any
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const errorJson = JSON.stringify(error);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("batch_item_checkpoints")
      .set({
        custom_id: item.customId,
        status: "errored",
        result_json: null,
        error_json: errorJson,
        updated_at: now,
      })
      .where("batch_id", "=", batchId)
      .where("line_number", "=", item.lineNumber)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `
    UPDATE batch_item_checkpoints
    SET custom_id = ?,
        status = 'errored',
        result_json = NULL,
        error_json = ?,
        updated_at = ?
    WHERE batch_id = ? AND line_number = ?
  `
  ).run(item.customId, errorJson, now, batchId, item.lineNumber);
}

export async function listBatches(
  apiKeyId?: string,
  limit: number = 20,
  after?: string
): Promise<BatchRecord[]> {
  const afterBatch = after ? await getBatch(after) : null;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().selectFrom("batches").selectAll();
    if (apiKeyId) {
      query = query.where("api_key_id", "=", apiKeyId);
    }
    if (afterBatch) {
      query = query.where((eb) =>
        eb.or([
          eb("created_at", "<", afterBatch.createdAt),
          eb.and([eb("created_at", "=", afterBatch.createdAt), eb("id", "<", after as string)]),
        ])
      );
    }
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map((row) => parseBatchRow(row));
  }

  const db = getDbInstance();
  let rows: any[];
  if (apiKeyId) {
    if (afterBatch) {
      rows = db
        .prepare(
          "SELECT * FROM batches WHERE api_key_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?"
        )
        .all(apiKeyId, afterBatch.createdAt, afterBatch.createdAt, after, limit);
    } else {
      rows = db
        .prepare(
          "SELECT * FROM batches WHERE api_key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"
        )
        .all(apiKeyId, limit);
    }
  } else if (afterBatch) {
    rows = db
      .prepare(
        "SELECT * FROM batches WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?"
      )
      .all(afterBatch.createdAt, afterBatch.createdAt, after, limit);
  } else {
    rows = db.prepare("SELECT * FROM batches ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
  }
  return rows.map((row) => parseBatchRow(row));
}

export async function countBatches(apiKeyId?: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb()
      .selectFrom("batches")
      .select((eb) => eb.fn.countAll().as("c"));
    if (apiKeyId) {
      query = query.where("api_key_id", "=", apiKeyId);
    }
    const row = await query.executeTakeFirst();
    return row ? toInt(row.c) : 0;
  }

  const db = getDbInstance();
  if (apiKeyId) {
    const row = db
      .prepare("SELECT COUNT(*) as c FROM batches WHERE api_key_id = ?")
      .get(apiKeyId) as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  } else {
    const row = db.prepare("SELECT COUNT(*) as c FROM batches").get() as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  }
}

export async function getPendingBatches(): Promise<BatchRecord[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("batches")
      .selectAll()
      .where("status", "in", ["validating", "in_progress", "finalizing", "cancelling"])
      .execute();
    return rows.map((row) => parseBatchRow(row));
  }

  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT * FROM batches WHERE status IN ('validating', 'in_progress', 'finalizing', 'cancelling')"
    )
    .all();
  return rows.map((row) => parseBatchRow(row));
}

export async function getTerminalBatches(): Promise<BatchRecord[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("batches")
      .selectAll()
      .where("status", "in", ["completed", "failed", "cancelled", "expired"])
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => parseBatchRow(row));
  }

  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT * FROM batches WHERE status IN ('completed', 'failed', 'cancelled', 'expired') ORDER BY created_at ASC"
    )
    .all();
  return rows.map((row) => parseBatchRow(row));
}

export async function deleteBatch(id: string): Promise<boolean> {
  const batch = await getBatch(id);
  if (!batch) return false;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb().deleteFrom("batch_item_checkpoints").where("batch_id", "=", id).execute();
  } else {
    const db = getDbInstance();
    db.prepare("DELETE FROM batch_item_checkpoints WHERE batch_id = ?").run(id);
  }

  // Soft-delete associated files (input, output, error)
  if (batch.inputFileId) {
    try {
      await deleteFile(batch.inputFileId);
    } catch {
      /* ignore */
    }
  }
  if (batch.outputFileId) {
    try {
      await deleteFile(batch.outputFileId);
    } catch {
      /* ignore */
    }
  }
  if (batch.errorFileId) {
    try {
      await deleteFile(batch.errorFileId);
    } catch {
      /* ignore */
    }
  }

  if (isPostgres()) {
    const result = await getKyselyDb()
      .deleteFrom("batches")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance();
  const result = db.prepare("DELETE FROM batches WHERE id = ?").run(id);
  return result.changes > 0;
}

export async function deleteCompletedBatches(): Promise<{
  deletedBatches: number;
  deletedFiles: number;
}> {
  let rows: Array<{
    input_file_id: string | null;
    output_file_id: string | null;
    error_file_id: string | null;
  }>;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    rows = await getKyselyDb()
      .selectFrom("batches")
      .select(["input_file_id", "output_file_id", "error_file_id"])
      .where("status", "=", "completed")
      .execute();
  } else {
    const db = getDbInstance();
    rows = db
      .prepare(
        "SELECT input_file_id, output_file_id, error_file_id FROM batches WHERE status = 'completed'"
      )
      .all() as typeof rows;
  }

  const fileIds = new Set<string>();
  for (const row of rows) {
    if (row.input_file_id) fileIds.add(row.input_file_id);
    if (row.output_file_id) fileIds.add(row.output_file_id);
    if (row.error_file_id) fileIds.add(row.error_file_id);
  }

  let deletedFiles = 0;
  for (const fid of fileIds) {
    try {
      if (await deleteFile(fid)) deletedFiles++;
    } catch {
      /* ignore */
    }
  }

  if (isPostgres()) {
    const kdb = getKyselyDb();
    await kdb
      .deleteFrom("batch_item_checkpoints")
      .where(
        "batch_id",
        "in",
        kdb.selectFrom("batches").select("id").where("status", "=", "completed")
      )
      .execute();
    const result = await kdb
      .deleteFrom("batches")
      .where("status", "=", "completed")
      .executeTakeFirst();
    return { deletedBatches: Number(result.numDeletedRows), deletedFiles };
  }

  const db = getDbInstance();
  db.prepare(
    "DELETE FROM batch_item_checkpoints WHERE batch_id IN (SELECT id FROM batches WHERE status = 'completed')"
  ).run();

  const result = db.prepare("DELETE FROM batches WHERE status = 'completed'").run();
  return { deletedBatches: result.changes, deletedFiles };
}
