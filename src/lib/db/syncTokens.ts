import { v4 as uuidv4 } from "uuid";
import { getDbInstance, rowToCamel } from "./core";
import { backupDbFile } from "./backup";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";
import { sql } from "kysely";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

type JsonRecord = Record<string, unknown>;

export interface SyncTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  syncApiKeyId: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  exec: (sql: string) => void;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toSyncTokenRecord(value: unknown): SyncTokenRecord | null {
  const record = asRecord(rowToCamel(value));
  if (typeof record.id !== "string" || typeof record.name !== "string") {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    tokenHash: typeof record.tokenHash === "string" ? record.tokenHash : "",
    syncApiKeyId: typeof record.syncApiKeyId === "string" ? record.syncApiKeyId : null,
    revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
    lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

function ensureSyncTokensTable(db: DbLike) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      sync_api_key_id TEXT,
      revoked_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sync_tokens_created_at ON sync_tokens(created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_tokens_last_used_at ON sync_tokens(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_sync_tokens_revoked_at ON sync_tokens(revoked_at);
    CREATE INDEX IF NOT EXISTS idx_sync_tokens_sync_api_key_id ON sync_tokens(sync_api_key_id);
  `);
}

export async function listSyncTokens() {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("sync_tokens")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy(sql`lower(name)`, "asc")
      .execute();
    return rows
      .map((row) => toSyncTokenRecord(row))
      .filter((row): row is SyncTokenRecord => row !== null);
  }

  const db = getDbInstance() as unknown as DbLike;
  ensureSyncTokensTable(db);
  const rows = db
    .prepare(
      "SELECT * FROM sync_tokens ORDER BY datetime(created_at) DESC, name COLLATE NOCASE ASC"
    )
    .all();

  return rows
    .map((row) => toSyncTokenRecord(row))
    .filter((row): row is SyncTokenRecord => row !== null);
}

export async function getSyncTokenById(id: string) {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("sync_tokens")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return toSyncTokenRecord(row);
  }

  const db = getDbInstance() as unknown as DbLike;
  ensureSyncTokensTable(db);
  const row = db.prepare("SELECT * FROM sync_tokens WHERE id = ?").get(id);
  return toSyncTokenRecord(row);
}

export async function getSyncTokenByHash(tokenHash: string) {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("sync_tokens")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    return toSyncTokenRecord(row);
  }

  const db = getDbInstance() as unknown as DbLike;
  ensureSyncTokensTable(db);
  const row = db.prepare("SELECT * FROM sync_tokens WHERE token_hash = ?").get(tokenHash);
  return toSyncTokenRecord(row);
}

export async function createSyncTokenRecord(data: {
  name: string;
  tokenHash: string;
  syncApiKeyId?: string | null;
}) {
  const now = new Date().toISOString();
  const record: SyncTokenRecord = {
    id: uuidv4(),
    name: data.name,
    tokenHash: data.tokenHash,
    syncApiKeyId: data.syncApiKeyId || null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("sync_tokens")
      .values({
        id: record.id,
        name: record.name,
        token_hash: record.tokenHash,
        sync_api_key_id: record.syncApiKeyId,
        revoked_at: record.revokedAt,
        last_used_at: record.lastUsedAt,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .execute();
    backupDbFile("pre-write");
    return record;
  }

  const db = getDbInstance() as unknown as DbLike;
  ensureSyncTokensTable(db);

  db.prepare(
    `INSERT INTO sync_tokens (
      id, name, token_hash, sync_api_key_id, revoked_at, last_used_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.name,
    record.tokenHash,
    record.syncApiKeyId,
    record.revokedAt,
    record.lastUsedAt,
    record.createdAt,
    record.updatedAt
  );

  backupDbFile("pre-write");
  return record;
}

export async function revokeSyncToken(id: string) {
  const existing = await getSyncTokenById(id);
  if (!existing) return null;
  if (existing.revokedAt) return existing;

  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("sync_tokens")
      .set({ revoked_at: now, updated_at: now })
      .where("id", "=", id)
      .execute();
    backupDbFile("pre-write");
    return await getSyncTokenById(id);
  }

  const db = getDbInstance() as unknown as DbLike;
  ensureSyncTokensTable(db);
  db.prepare("UPDATE sync_tokens SET revoked_at = ?, updated_at = ? WHERE id = ?").run(
    now,
    now,
    id
  );
  backupDbFile("pre-write");
  return await getSyncTokenById(id);
}

export async function touchSyncTokenLastUsed(id: string, usedAt = new Date().toISOString()) {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .updateTable("sync_tokens")
      .set({ last_used_at: usedAt, updated_at: usedAt })
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows || 0) > 0;
  }

  const db = getDbInstance() as unknown as DbLike;
  ensureSyncTokensTable(db);
  const result = db
    .prepare("UPDATE sync_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?")
    .run(usedAt, usedAt, id);
  return Number(result.changes || 0) > 0;
}
