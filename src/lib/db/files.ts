import { getDbInstance, rowToCamel, objToSnake } from "./core";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_BATCH_EXPIRATION_SECONDS } from "@/shared/constants/batch";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export interface FileRecord {
  id: string;
  bytes: number;
  createdAt: number;
  filename: string;
  purpose: string;
  content?: Buffer | null;
  mimeType?: string | null;
  apiKeyId?: string | null;
  expiresAt?: number | null;
  deletedAt?: number | null;
}

const FILE_METADATA_COLUMNS =
  "id, bytes, created_at, filename, purpose, mime_type, api_key_id, expires_at, deleted_at";

export async function createFile(file: Omit<FileRecord, "id" | "createdAt">): Promise<FileRecord> {
  const id = "file-" + uuidv4().replaceAll("-", "").substring(0, 24);
  const createdAt = Math.floor(Date.now() / 1000);

  let expiresAt = file.expiresAt;
  if (expiresAt === undefined && file.purpose === "batch") {
    // Default: batch files expire after 30 days
    expiresAt = createdAt + DEFAULT_BATCH_EXPIRATION_SECONDS;
  }

  const record: FileRecord = {
    id,
    bytes: file.bytes,
    createdAt,
    filename: file.filename,
    purpose: file.purpose,
    content: file.content ?? null,
    mimeType: file.mimeType ?? null,
    apiKeyId: file.apiKeyId ?? null,
    expiresAt: expiresAt ?? null,
    deletedAt: null,
  };

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("files")
      .values({
        id: record.id,
        bytes: record.bytes,
        created_at: record.createdAt,
        filename: record.filename,
        purpose: record.purpose,
        content: record.content,
        mime_type: record.mimeType,
        api_key_id: record.apiKeyId,
        expires_at: record.expiresAt,
        deleted_at: record.deletedAt,
      })
      .execute();
    return record;
  }

  const db = getDbInstance();
  db.prepare(
    `
    INSERT INTO files (id, bytes, created_at, filename, purpose, content, mime_type, api_key_id, expires_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    record.id,
    record.bytes,
    record.createdAt,
    record.filename,
    record.purpose,
    record.content,
    record.mimeType,
    record.apiKeyId,
    record.expiresAt,
    record.deletedAt
  );

  return record;
}

export async function getFile(id: string): Promise<FileRecord | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("files")
      .select([
        "id",
        "bytes",
        "created_at",
        "filename",
        "purpose",
        "mime_type",
        "api_key_id",
        "expires_at",
        "deleted_at",
      ])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row ? (rowToCamel(row) as unknown as FileRecord) : null;
  }

  const db = getDbInstance();
  const row = db
    .prepare(`SELECT ${FILE_METADATA_COLUMNS} FROM files WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return row ? (rowToCamel(row) as unknown as FileRecord) : null;
}

export async function getFileContent(id: string): Promise<Buffer | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("files")
      .select(["content"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row?.content) return null;
    return Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT content FROM files WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { content: Buffer | Uint8Array | string | null } | undefined;
  if (!row?.content) return null;
  return Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
}

export async function listFiles(
  options: {
    apiKeyId?: string;
    purpose?: string;
    limit?: number;
    after?: string;
    order?: "asc" | "desc";
  } = {}
): Promise<FileRecord[]> {
  const { apiKeyId, purpose, limit = 20, after, order = "desc" } = options;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb()
      .selectFrom("files")
      .select([
        "id",
        "bytes",
        "created_at",
        "filename",
        "purpose",
        "mime_type",
        "api_key_id",
        "expires_at",
        "deleted_at",
      ])
      .where("deleted_at", "is", null);

    if (apiKeyId) query = query.where("api_key_id", "=", apiKeyId);
    if (purpose) query = query.where("purpose", "=", purpose);

    if (after) {
      const afterFile = await getFile(after);
      if (afterFile) {
        if (order === "desc") {
          query = query.where((eb) =>
            eb.or([
              eb("created_at", "<", afterFile.createdAt),
              eb.and([eb("created_at", "=", afterFile.createdAt), eb("id", "<", after)]),
            ])
          );
        } else {
          query = query.where((eb) =>
            eb.or([
              eb("created_at", ">", afterFile.createdAt),
              eb.and([eb("created_at", "=", afterFile.createdAt), eb("id", ">", after)]),
            ])
          );
        }
      }
    }

    const rows = await query
      .orderBy("created_at", order === "asc" ? "asc" : "desc")
      .orderBy("id", order === "asc" ? "asc" : "desc")
      .limit(limit)
      .execute();

    return rows.map((row) => rowToCamel(row) as unknown as FileRecord);
  }

  const db = getDbInstance();
  let query = `SELECT ${FILE_METADATA_COLUMNS} FROM files WHERE deleted_at IS NULL`;
  const params: any[] = [];

  if (apiKeyId) {
    query += " AND api_key_id = ?";
    params.push(apiKeyId);
  }

  if (purpose) {
    query += " AND purpose = ?";
    params.push(purpose);
  }

  if (after) {
    // Get the creation time of the 'after' file to use for pagination
    const afterFile = await getFile(after);
    if (afterFile) {
      if (order === "desc") {
        query += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      } else {
        query += " AND (created_at > ? OR (created_at = ? AND id > ?))";
      }
      params.push(afterFile.createdAt, afterFile.createdAt, after);
    }
  }

  query += ` ORDER BY created_at ${order === "asc" ? "ASC" : "DESC"}, id ${order === "asc" ? "ASC" : "DESC"}`;
  query += " LIMIT ?";
  params.push(limit);

  const rows = db.prepare(query).all(...params);
  return rows.map((row) => rowToCamel(row) as unknown as FileRecord);
}

export async function countFiles(
  options: { apiKeyId?: string; purpose?: string } = {}
): Promise<number> {
  const { apiKeyId, purpose } = options;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb()
      .selectFrom("files")
      .select((eb) => eb.fn.countAll().as("c"))
      .where("deleted_at", "is", null);
    if (apiKeyId) query = query.where("api_key_id", "=", apiKeyId);
    if (purpose) query = query.where("purpose", "=", purpose);
    const row = await query.executeTakeFirst();
    return row ? Number(row.c) : 0;
  }

  const db = getDbInstance();
  let query = "SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL";
  const params: any[] = [];
  if (apiKeyId) {
    query += " AND api_key_id = ?";
    params.push(apiKeyId);
  }
  if (purpose) {
    query += " AND purpose = ?";
    params.push(purpose);
  }
  const row = db.prepare(query).get(...params) as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

export function formatFileResponse(file: FileRecord) {
  // Ensure numeric date fields are valid numbers to avoid NaN in API responses
  const createdAt =
    typeof file.createdAt === "number" && Number.isFinite(file.createdAt) ? file.createdAt : 0;
  const expiresAt =
    typeof file.expiresAt === "number" && Number.isFinite(file.expiresAt) ? file.expiresAt : null;

  return {
    id: file.id,
    bytes: file.bytes,
    created_at: createdAt,
    filename: file.filename,
    object: "file",
    purpose: file.purpose,
    expires_at: expiresAt,
  };
}

export async function deleteFile(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .updateTable("files")
      .set({ deleted_at: Math.floor(Date.now() / 1000), content: null })
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  const db = getDbInstance();
  const result = db
    .prepare("UPDATE files SET deleted_at = ?, content = NULL WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}
