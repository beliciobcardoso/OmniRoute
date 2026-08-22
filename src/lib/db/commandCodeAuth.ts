import { createHash, randomUUID } from "crypto";

import { getDbInstance, rowToCamel } from "./core";
import { decrypt, encrypt } from "./encryption";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export type CommandCodeAuthStatus = "pending" | "received" | "applied" | "expired";

export interface CommandCodeAuthMetadata {
  userId?: string;
  userName?: string;
  keyName?: string;
  receivedAt?: string;
}

export interface CommandCodeAuthSafeStatus {
  id: string;
  stateHash: string;
  status: CommandCodeAuthStatus;
  metadata: CommandCodeAuthMetadata | null;
  createdAt: string;
  expiresAt: string;
  receivedAt: string | null;
  appliedAt: string | null;
  updatedAt: string;
}

export interface ConsumedCommandCodeAuthSecret extends CommandCodeAuthSafeStatus {
  apiKey: string;
}

type DbRunResult = { changes?: number };
type DbStatement<TRow = unknown> = {
  get: (...params: unknown[]) => TRow | undefined;
  all: (...params: unknown[]) => TRow[];
  run: (...params: unknown[]) => DbRunResult;
};
type DbLike = {
  prepare: <TRow = unknown>(sql: string) => DbStatement<TRow>;
  transaction: <T extends (...args: unknown[]) => unknown>(fn: T) => T;
};

type AuthSessionRow = {
  id: string;
  state_hash: string;
  status: CommandCodeAuthStatus;
  encrypted_api_key?: string | null;
  metadata_json?: string | null;
  created_at: string;
  expires_at: string;
  received_at?: string | null;
  applied_at?: string | null;
  updated_at: string;
};

function db(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

export function hashCommandCodeAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseMetadata(value: unknown): CommandCodeAuthMetadata | null {
  if (!value) return null;
  // rowToCamel auto-parses the `metadata_json` column and exposes the object under
  // `camel.metadata` (already parsed); accept that directly. Fall back to parsing a
  // raw string for any other caller.
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as CommandCodeAuthMetadata;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as CommandCodeAuthMetadata;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function toSafeStatus(row: AuthSessionRow): CommandCodeAuthSafeStatus {
  const camel = rowToCamel(row) as Record<string, unknown>;
  return {
    id: String(camel.id),
    stateHash: String(camel.stateHash),
    status: camel.status as CommandCodeAuthStatus,
    metadata: parseMetadata(camel.metadata ?? camel.metadataJson),
    createdAt: String(camel.createdAt),
    expiresAt: String(camel.expiresAt),
    receivedAt: (camel.receivedAt as string | null | undefined) ?? null,
    appliedAt: (camel.appliedAt as string | null | undefined) ?? null,
    updatedAt: String(camel.updatedAt),
  };
}

async function markExpiredForState(stateHash: string, now = nowIso()): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("command_code_auth_sessions")
      .set({ status: "expired", updated_at: now })
      .where("state_hash", "=", stateHash)
      .where("status", "in", ["pending", "received"])
      .where("expires_at", "<=", now)
      .execute();
    return;
  }

  db()
    .prepare(
      `UPDATE command_code_auth_sessions
       SET status = 'expired', updated_at = ?
       WHERE state_hash = ? AND status IN ('pending', 'received') AND expires_at <= ?`
    )
    .run(now, stateHash, now);
}

export async function createPendingCommandCodeAuthSession(input: {
  stateHash: string;
  expiresAt: string;
}): Promise<CommandCodeAuthSafeStatus> {
  const id = randomUUID();
  const now = nowIso();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("command_code_auth_sessions")
      .values({
        id,
        state_hash: input.stateHash,
        status: "pending",
        encrypted_api_key: null,
        metadata_json: null,
        created_at: now,
        expires_at: input.expiresAt,
        received_at: null,
        applied_at: null,
        updated_at: now,
      })
      .execute();

    const row = await kdb
      .selectFrom("command_code_auth_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw new Error("Failed to create Command Code auth session");
    return toSafeStatus(row as unknown as AuthSessionRow);
  }

  db()
    .prepare(
      `INSERT INTO command_code_auth_sessions (
        id, state_hash, status, encrypted_api_key, metadata_json,
        created_at, expires_at, received_at, applied_at, updated_at
      ) VALUES (?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(id, input.stateHash, now, input.expiresAt, now);

  const row = db()
    .prepare<AuthSessionRow>("SELECT * FROM command_code_auth_sessions WHERE id = ?")
    .get(id);
  if (!row) throw new Error("Failed to create Command Code auth session");
  return toSafeStatus(row);
}

export async function markCommandCodeAuthSessionReceived(input: {
  stateHash: string;
  apiKey: string;
  metadata?: CommandCodeAuthMetadata;
}): Promise<CommandCodeAuthSafeStatus | null> {
  const now = nowIso();
  await markExpiredForState(input.stateHash, now);
  const metadata: CommandCodeAuthMetadata = {
    ...(input.metadata || {}),
    receivedAt: now,
  };
  const encryptedApiKey = encrypt(input.apiKey);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("command_code_auth_sessions")
      .set({
        status: "received",
        encrypted_api_key: encryptedApiKey,
        metadata_json: JSON.stringify(metadata),
        received_at: now,
        updated_at: now,
      })
      .where("state_hash", "=", input.stateHash)
      .where("status", "in", ["pending", "received"])
      .where("expires_at", ">", now)
      .execute();
    return getCommandCodeAuthSessionSafeStatus(input.stateHash);
  }

  db()
    .prepare(
      `UPDATE command_code_auth_sessions
       SET status = 'received', encrypted_api_key = ?, metadata_json = ?, received_at = ?, updated_at = ?
       WHERE state_hash = ? AND status IN ('pending', 'received') AND expires_at > ?`
    )
    .run(encryptedApiKey, JSON.stringify(metadata), now, now, input.stateHash, now);

  return getCommandCodeAuthSessionSafeStatus(input.stateHash);
}

export async function getCommandCodeAuthSessionSafeStatus(
  stateHash: string
): Promise<CommandCodeAuthSafeStatus | null> {
  await markExpiredForState(stateHash);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("command_code_auth_sessions")
      .selectAll()
      .where("state_hash", "=", stateHash)
      .executeTakeFirst();
    return row ? toSafeStatus(row as unknown as AuthSessionRow) : null;
  }

  const row = db()
    .prepare<AuthSessionRow>("SELECT * FROM command_code_auth_sessions WHERE state_hash = ?")
    .get(stateHash);
  return row ? toSafeStatus(row) : null;
}

export async function consumeCommandCodeAuthSecret(
  stateHash: string
): Promise<ConsumedCommandCodeAuthSecret | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    return getKyselyDb()
      .transaction()
      .execute(async (trx) => {
        const now = nowIso();
        await trx
          .updateTable("command_code_auth_sessions")
          .set({ status: "expired", updated_at: now })
          .where("state_hash", "=", stateHash)
          .where("status", "in", ["pending", "received"])
          .where("expires_at", "<=", now)
          .execute();

        const row = await trx
          .selectFrom("command_code_auth_sessions")
          .selectAll()
          .where("state_hash", "=", stateHash)
          .where("status", "=", "received")
          .where("expires_at", ">", now)
          .where("encrypted_api_key", "is not", null)
          .executeTakeFirst();
        if (!row?.encrypted_api_key) return null;

        const apiKey = decrypt(row.encrypted_api_key);
        if (!apiKey) return null;

        const result = await trx
          .updateTable("command_code_auth_sessions")
          .set({ status: "applied", encrypted_api_key: null, applied_at: now, updated_at: now })
          .where("id", "=", row.id)
          .where("status", "=", "received")
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) === 0) return null;

        return {
          ...toSafeStatus({
            ...row,
            status: "applied",
            encrypted_api_key: null,
            applied_at: now,
            updated_at: now,
          }),
          apiKey,
        };
      });
  }

  const database = db();
  return database.transaction(() => {
    const now = nowIso();
    database
      .prepare(
        `UPDATE command_code_auth_sessions
         SET status = 'expired', updated_at = ?
         WHERE state_hash = ? AND status IN ('pending', 'received') AND expires_at <= ?`
      )
      .run(now, stateHash, now);

    const row = database
      .prepare<AuthSessionRow>(
        `SELECT * FROM command_code_auth_sessions
         WHERE state_hash = ? AND status = 'received' AND expires_at > ? AND encrypted_api_key IS NOT NULL`
      )
      .get(stateHash, now);
    if (!row?.encrypted_api_key) return null;

    const apiKey = decrypt(row.encrypted_api_key);
    if (!apiKey) return null;

    const result = database
      .prepare(
        `UPDATE command_code_auth_sessions
         SET status = 'applied', encrypted_api_key = NULL, applied_at = ?, updated_at = ?
         WHERE id = ? AND status = 'received'`
      )
      .run(now, now, row.id);
    if (!result.changes) return null;

    return {
      ...toSafeStatus({
        ...row,
        status: "applied",
        encrypted_api_key: null,
        applied_at: now,
        updated_at: now,
      }),
      apiKey,
    };
  })() as ConsumedCommandCodeAuthSecret | null;
}
