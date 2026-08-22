/**
 * db/registeredKeys.ts — Registered Keys Provisioning (#464)
 *
 * Handles:
 *   - Issuing registered keys with idempotency
 *   - Per-provider and per-account quota enforcement
 *   - Key revocation
 *   - Quota status queries for rate-limiting decisions
 */

import { createHash, randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { sql } from "kysely";
import { getDbInstance, rowToCamel } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value);
}

// Postgres BIGINT columns come back as JS strings; only these numeric fields
// need coercion before use — everything else (ids, text, timestamps) is fine
// passed straight through rowToCamel, matching existing SQLite behavior exactly.
function normalizeRegisteredKeyRow<
  T extends {
    dailyBudget?: unknown;
    hourlyBudget?: unknown;
    dailyUsed?: unknown;
    hourlyUsed?: unknown;
    isActive?: unknown;
  },
>(camel: T): T {
  return {
    ...camel,
    dailyBudget: toIntOrNull(camel.dailyBudget),
    hourlyBudget: toIntOrNull(camel.hourlyBudget),
    dailyUsed: toInt(camel.dailyUsed),
    hourlyUsed: toInt(camel.hourlyUsed),
    isActive: toInt(camel.isActive),
  };
}

function normalizeKeyLimitRawRow<
  T extends {
    max_active_keys?: unknown;
    daily_issue_limit?: unknown;
    hourly_issue_limit?: unknown;
    daily_issued?: unknown;
    hourly_issued?: unknown;
  },
>(row: T): T {
  return {
    ...row,
    max_active_keys: toIntOrNull(row.max_active_keys),
    daily_issue_limit: toIntOrNull(row.daily_issue_limit),
    hourly_issue_limit: toIntOrNull(row.hourly_issue_limit),
    daily_issued: toInt(row.daily_issued),
    hourly_issued: toInt(row.hourly_issued),
  };
}

function normalizeKeyLimitRow<
  T extends {
    maxActiveKeys?: unknown;
    dailyIssueLimit?: unknown;
    hourlyIssueLimit?: unknown;
    dailyIssued?: unknown;
    hourlyIssued?: unknown;
  },
>(camel: T): T {
  return {
    ...camel,
    maxActiveKeys: toIntOrNull(camel.maxActiveKeys),
    dailyIssueLimit: toIntOrNull(camel.dailyIssueLimit),
    hourlyIssueLimit: toIntOrNull(camel.hourlyIssueLimit),
    dailyIssued: toInt(camel.dailyIssued),
    hourlyIssued: toInt(camel.hourlyIssued),
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RegisteredKey {
  id: string;
  keyPrefix: string;
  name: string;
  provider: string;
  accountId: string;
  isActive: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
  idempotencyKey: string | null;
  dailyBudget: number | null;
  hourlyBudget: number | null;
  dailyUsed: number;
  hourlyUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisteredKeyWithSecret extends RegisteredKey {
  /** Raw key material — only returned once on creation */
  rawKey: string;
}

export interface ProviderKeyLimit {
  provider: string;
  maxActiveKeys: number | null;
  dailyIssueLimit: number | null;
  hourlyIssueLimit: number | null;
  dailyIssued: number;
  hourlyIssued: number;
  updatedAt: string;
}

export interface AccountKeyLimit {
  accountId: string;
  maxActiveKeys: number | null;
  dailyIssueLimit: number | null;
  hourlyIssueLimit: number | null;
  dailyIssued: number;
  hourlyIssued: number;
  updatedAt: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  errorCode?: string;
  errorMessage?: string;
  provider?: string;
  accountId?: string;
  providerActiveKeys?: number;
  accountActiveKeys?: number;
}

export interface IssueKeyParams {
  name: string;
  provider?: string;
  accountId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
  dailyBudget?: number;
  hourlyBudget?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function nowHour(): string {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function hashKey(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawKey(): string {
  // ork_ prefix so users can easily identify these keys
  return "ork_" + randomBytes(24).toString("base64url");
}

/** Reset window counters if the tracking period has changed. */
async function maybeResetWindow(
  table: "provider_key_limits" | "account_key_limits",
  idField: "provider" | "account_id",
  idValue: string
): Promise<void> {
  const today = nowDay();
  const hour = nowHour();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await sql`
      UPDATE ${sql.raw(table)}
      SET daily_issued = CASE WHEN last_reset_day <> ${today} THEN 0 ELSE daily_issued END,
          hourly_issued = CASE WHEN last_reset_hour <> ${hour} THEN 0 ELSE hourly_issued END,
          last_reset_day = ${today},
          last_reset_hour = ${hour}
      WHERE ${sql.raw(idField)} = ${idValue}
    `.execute(getKyselyDb());
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `
    UPDATE ${table}
    SET daily_issued = CASE WHEN last_reset_day <> ? THEN 0 ELSE daily_issued END,
        hourly_issued = CASE WHEN last_reset_hour <> ? THEN 0 ELSE hourly_issued END,
        last_reset_day = ?,
        last_reset_hour = ?
    WHERE ${idField} = ?
  `
  ).run(today, hour, today, hour, idValue);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a new registered key can be issued for the given provider/account.
 * Returns { allowed: true } or { allowed: false, errorCode, errorMessage }.
 */
export async function checkQuota(provider = "", accountId = ""): Promise<QuotaCheckResult> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    // ── provider-level check ──
    if (provider) {
      await maybeResetWindow("provider_key_limits", "provider", provider);

      const limitsRow = await kdb
        .selectFrom("provider_key_limits")
        .selectAll()
        .where("provider", "=", provider)
        .executeTakeFirst();

      if (limitsRow) {
        const limits = normalizeKeyLimitRawRow(limitsRow);
        if (
          limits.hourly_issue_limit !== null &&
          limits.hourly_issued >= limits.hourly_issue_limit
        ) {
          return {
            allowed: false,
            errorCode: "PROVIDER_QUOTA_EXCEEDED",
            errorMessage: `Hourly issue limit (${limits.hourly_issue_limit}) reached for provider '${provider}'`,
            provider,
          };
        }
        if (limits.daily_issue_limit !== null && limits.daily_issued >= limits.daily_issue_limit) {
          return {
            allowed: false,
            errorCode: "PROVIDER_QUOTA_EXCEEDED",
            errorMessage: `Daily issue limit (${limits.daily_issue_limit}) reached for provider '${provider}'`,
            provider,
          };
        }
        if (limits.max_active_keys !== null) {
          const countRow = await kdb
            .selectFrom("registered_keys")
            .select((eb) => eb.fn.countAll().as("activeCount"))
            .where("provider", "=", provider)
            .where("is_active", "=", 1)
            .executeTakeFirst();
          const activeCount = toInt(countRow?.activeCount);
          if (activeCount >= limits.max_active_keys) {
            return {
              allowed: false,
              errorCode: "MAX_ACTIVE_KEYS_EXCEEDED",
              errorMessage: `Max active keys (${limits.max_active_keys}) reached for provider '${provider}'`,
              provider,
              providerActiveKeys: activeCount,
            };
          }
        }
      }
    }

    // ── account-level check ──
    if (accountId) {
      await maybeResetWindow("account_key_limits", "account_id", accountId);

      const limitsRow = await kdb
        .selectFrom("account_key_limits")
        .selectAll()
        .where("account_id", "=", accountId)
        .executeTakeFirst();

      if (limitsRow) {
        const limits = normalizeKeyLimitRawRow(limitsRow);
        if (
          limits.hourly_issue_limit !== null &&
          limits.hourly_issued >= limits.hourly_issue_limit
        ) {
          return {
            allowed: false,
            errorCode: "ACCOUNT_QUOTA_EXCEEDED",
            errorMessage: `Hourly issue limit (${limits.hourly_issue_limit}) reached for account '${accountId}'`,
            accountId,
          };
        }
        if (limits.daily_issue_limit !== null && limits.daily_issued >= limits.daily_issue_limit) {
          return {
            allowed: false,
            errorCode: "ACCOUNT_QUOTA_EXCEEDED",
            errorMessage: `Daily issue limit (${limits.daily_issue_limit}) reached for account '${accountId}'`,
            accountId,
          };
        }
        if (limits.max_active_keys !== null) {
          const countRow = await kdb
            .selectFrom("registered_keys")
            .select((eb) => eb.fn.countAll().as("activeCount"))
            .where("account_id", "=", accountId)
            .where("is_active", "=", 1)
            .executeTakeFirst();
          const activeCount = toInt(countRow?.activeCount);
          if (activeCount >= limits.max_active_keys) {
            return {
              allowed: false,
              errorCode: "MAX_ACTIVE_KEYS_EXCEEDED",
              errorMessage: `Max active keys (${limits.max_active_keys}) reached for account '${accountId}'`,
              accountId,
              accountActiveKeys: activeCount,
            };
          }
        }
      }
    }

    return { allowed: true };
  }

  const db = getDbInstance();

  // ── provider-level check ──
  if (provider) {
    await maybeResetWindow("provider_key_limits", "provider", provider);

    const limits = db
      .prepare("SELECT * FROM provider_key_limits WHERE provider = ?")
      .get(provider) as ProviderKeyLimitRow | undefined;

    if (limits) {
      if (limits.hourly_issue_limit !== null && limits.hourly_issued >= limits.hourly_issue_limit) {
        return {
          allowed: false,
          errorCode: "PROVIDER_QUOTA_EXCEEDED",
          errorMessage: `Hourly issue limit (${limits.hourly_issue_limit}) reached for provider '${provider}'`,
          provider,
        };
      }
      if (limits.daily_issue_limit !== null && limits.daily_issued >= limits.daily_issue_limit) {
        return {
          allowed: false,
          errorCode: "PROVIDER_QUOTA_EXCEEDED",
          errorMessage: `Daily issue limit (${limits.daily_issue_limit}) reached for provider '${provider}'`,
          provider,
        };
      }
      if (limits.max_active_keys !== null) {
        const { activeCount } = db
          .prepare(
            "SELECT COUNT(*) as activeCount FROM registered_keys WHERE provider = ? AND is_active = 1"
          )
          .get(provider) as { activeCount: number };
        if (activeCount >= limits.max_active_keys) {
          return {
            allowed: false,
            errorCode: "MAX_ACTIVE_KEYS_EXCEEDED",
            errorMessage: `Max active keys (${limits.max_active_keys}) reached for provider '${provider}'`,
            provider,
            providerActiveKeys: activeCount,
          };
        }
      }
    }
  }

  // ── account-level check ──
  if (accountId) {
    await maybeResetWindow("account_key_limits", "account_id", accountId);

    const limits = db
      .prepare("SELECT * FROM account_key_limits WHERE account_id = ?")
      .get(accountId) as AccountKeyLimitRow | undefined;

    if (limits) {
      if (limits.hourly_issue_limit !== null && limits.hourly_issued >= limits.hourly_issue_limit) {
        return {
          allowed: false,
          errorCode: "ACCOUNT_QUOTA_EXCEEDED",
          errorMessage: `Hourly issue limit (${limits.hourly_issue_limit}) reached for account '${accountId}'`,
          accountId,
        };
      }
      if (limits.daily_issue_limit !== null && limits.daily_issued >= limits.daily_issue_limit) {
        return {
          allowed: false,
          errorCode: "ACCOUNT_QUOTA_EXCEEDED",
          errorMessage: `Daily issue limit (${limits.daily_issue_limit}) reached for account '${accountId}'`,
          accountId,
        };
      }
      if (limits.max_active_keys !== null) {
        const { activeCount } = db
          .prepare(
            "SELECT COUNT(*) as activeCount FROM registered_keys WHERE account_id = ? AND is_active = 1"
          )
          .get(accountId) as { activeCount: number };
        if (activeCount >= limits.max_active_keys) {
          return {
            allowed: false,
            errorCode: "MAX_ACTIVE_KEYS_EXCEEDED",
            errorMessage: `Max active keys (${limits.max_active_keys}) reached for account '${accountId}'`,
            accountId,
            accountActiveKeys: activeCount,
          };
        }
      }
    }
  }

  return { allowed: true };
}

/**
 * Issue a new registered key.
 * Returns the key with rawKey (only on creation) or null if idempotency_key already exists.
 */
export async function issueRegisteredKey(
  params: IssueKeyParams
): Promise<RegisteredKeyWithSecret | { idempotencyConflict: true; existing: RegisteredKey }> {
  const {
    name,
    provider = "",
    accountId = "",
    idempotencyKey,
    expiresAt,
    dailyBudget,
    hourlyBudget,
  } = params;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    // ── idempotency check ──
    if (idempotencyKey) {
      const existing = await kdb
        .selectFrom("registered_keys")
        .selectAll()
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        return {
          idempotencyConflict: true,
          existing: normalizeRegisteredKeyRow(rowToCamel(existing) as unknown as RegisteredKey),
        };
      }
    }

    const rawKey = generateRawKey();
    const id = uuidv4();
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12);

    await kdb
      .insertInto("registered_keys")
      .values({
        id,
        key: keyHash,
        key_prefix: keyPrefix,
        name,
        provider,
        account_id: accountId,
        idempotency_key: idempotencyKey ?? null,
        expires_at: expiresAt ?? null,
        daily_budget: dailyBudget ?? null,
        hourly_budget: hourlyBudget ?? null,
        last_reset_day: nowDay(),
        last_reset_hour: nowHour(),
      })
      .execute();

    if (provider) {
      await maybeResetWindow("provider_key_limits", "provider", provider);
      await kdb
        .insertInto("provider_key_limits")
        .values({
          provider,
          daily_issued: 1,
          hourly_issued: 1,
          last_reset_day: nowDay(),
          last_reset_hour: nowHour(),
        })
        .onConflict((oc) =>
          oc.column("provider").doUpdateSet({
            daily_issued: (eb) => eb("provider_key_limits.daily_issued", "+", 1),
            hourly_issued: (eb) => eb("provider_key_limits.hourly_issued", "+", 1),
            updated_at: new Date().toISOString(),
          })
        )
        .execute();
    }
    if (accountId) {
      await maybeResetWindow("account_key_limits", "account_id", accountId);
      await kdb
        .insertInto("account_key_limits")
        .values({
          account_id: accountId,
          daily_issued: 1,
          hourly_issued: 1,
          last_reset_day: nowDay(),
          last_reset_hour: nowHour(),
        })
        .onConflict((oc) =>
          oc.column("account_id").doUpdateSet({
            daily_issued: (eb) => eb("account_key_limits.daily_issued", "+", 1),
            hourly_issued: (eb) => eb("account_key_limits.hourly_issued", "+", 1),
            updated_at: new Date().toISOString(),
          })
        )
        .execute();
    }

    const created = await kdb
      .selectFrom("registered_keys")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return {
      ...normalizeRegisteredKeyRow(rowToCamel(created) as unknown as RegisteredKey),
      rawKey,
    };
  }

  const db = getDbInstance();

  // ── idempotency check ──
  if (idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM registered_keys WHERE idempotency_key = ?")
      .get(idempotencyKey) as RegisteredKeyRow | undefined;
    if (existing) {
      return {
        idempotencyConflict: true,
        existing: rowToCamel(existing) as unknown as RegisteredKey,
      };
    }
  }

  const rawKey = generateRawKey();
  const id = uuidv4();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // "ork_" + 8 chars

  db.prepare(
    `
    INSERT INTO registered_keys
      (id, key, key_prefix, name, provider, account_id, idempotency_key, expires_at, daily_budget, hourly_budget, last_reset_day, last_reset_hour)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    keyHash,
    keyPrefix,
    name,
    provider,
    accountId,
    idempotencyKey ?? null,
    expiresAt ?? null,
    dailyBudget ?? null,
    hourlyBudget ?? null,
    nowDay(),
    nowHour()
  );

  // Increment provider/account issuance counters
  if (provider) {
    await maybeResetWindow("provider_key_limits", "provider", provider);
    db.prepare(
      `
      INSERT INTO provider_key_limits (provider, daily_issued, hourly_issued, last_reset_day, last_reset_hour)
      VALUES (?, 1, 1, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        daily_issued = daily_issued + 1,
        hourly_issued = hourly_issued + 1,
        updated_at = datetime('now')
    `
    ).run(provider, nowDay(), nowHour());
  }
  if (accountId) {
    await maybeResetWindow("account_key_limits", "account_id", accountId);
    db.prepare(
      `
      INSERT INTO account_key_limits (account_id, daily_issued, hourly_issued, last_reset_day, last_reset_hour)
      VALUES (?, 1, 1, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        daily_issued = daily_issued + 1,
        hourly_issued = hourly_issued + 1,
        updated_at = datetime('now')
    `
    ).run(accountId, nowDay(), nowHour());
  }

  const created = db
    .prepare("SELECT * FROM registered_keys WHERE id = ?")
    .get(id) as RegisteredKeyRow;
  return { ...(rowToCamel(created) as unknown as RegisteredKey), rawKey };
}

/**
 * Get a registered key by ID (without the raw key — only prefix is returned).
 */
export async function getRegisteredKey(id: string): Promise<RegisteredKey | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("registered_keys")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? normalizeRegisteredKeyRow(rowToCamel(row) as unknown as RegisteredKey) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM registered_keys WHERE id = ?").get(id) as
    RegisteredKeyRow | undefined;
  return row ? (rowToCamel(row) as unknown as RegisteredKey) : null;
}

/**
 * List all registered keys (optionally filtered by provider/accountId).
 */
export async function listRegisteredKeys(
  opts: { provider?: string; accountId?: string } = {}
): Promise<RegisteredKey[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().selectFrom("registered_keys").selectAll();
    if (opts.provider) query = query.where("provider", "=", opts.provider);
    if (opts.accountId) query = query.where("account_id", "=", opts.accountId);
    const rows = await query.orderBy("created_at", "desc").limit(500).execute();
    return rows.map((r) => normalizeRegisteredKeyRow(rowToCamel(r) as unknown as RegisteredKey));
  }

  const db = getDbInstance();
  let queryText = "SELECT * FROM registered_keys WHERE 1=1";
  const args: string[] = [];
  if (opts.provider) {
    queryText += " AND provider = ?";
    args.push(opts.provider);
  }
  if (opts.accountId) {
    queryText += " AND account_id = ?";
    args.push(opts.accountId);
  }
  queryText += " ORDER BY created_at DESC LIMIT 500";
  const rows = db.prepare(queryText).all(...args) as RegisteredKeyRow[];
  return rows.map((r) => rowToCamel(r) as unknown as RegisteredKey);
}

/**
 * Revoke a registered key by ID.
 */
export async function revokeRegisteredKey(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    const result = await getKyselyDb()
      .updateTable("registered_keys")
      .set({ is_active: 0, revoked_at: now, updated_at: now })
      .where("id", "=", id)
      .where("is_active", "=", 1)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  const db = getDbInstance();
  const result = db
    .prepare(
      `
    UPDATE registered_keys
    SET is_active = 0, revoked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND is_active = 1
  `
    )
    .run(id);
  return result.changes > 0;
}

/**
 * Validate a raw registered key against stored hashes.
 * Returns the key metadata if valid, null otherwise.
 */
export async function validateRegisteredKey(rawKey: string): Promise<RegisteredKey | null> {
  const hash = hashKey(rawKey);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const nowIso = new Date().toISOString();
    const row = await kdb
      .selectFrom("registered_keys")
      .selectAll()
      .where("key", "=", hash)
      .where("is_active", "=", 1)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", nowIso)]))
      .executeTakeFirst();
    if (!row) return null;

    const today = nowDay();
    const hour = nowHour();
    if (row.last_reset_day !== today || row.last_reset_hour !== hour) {
      await kdb
        .updateTable("registered_keys")
        .set({
          daily_used: row.last_reset_day !== today ? 0 : toInt(row.daily_used),
          hourly_used: row.last_reset_hour !== hour ? 0 : toInt(row.hourly_used),
          last_reset_day: today,
          last_reset_hour: hour,
        })
        .where("id", "=", row.id)
        .execute();
    }

    const dailyBudget = toIntOrNull(row.daily_budget);
    const hourlyBudget = toIntOrNull(row.hourly_budget);
    const dailyUsed = row.last_reset_day !== today ? 0 : toInt(row.daily_used);
    const hourlyUsed = row.last_reset_hour !== hour ? 0 : toInt(row.hourly_used);
    if (dailyBudget !== null && dailyUsed >= dailyBudget) return null;
    if (hourlyBudget !== null && hourlyUsed >= hourlyBudget) return null;

    return normalizeRegisteredKeyRow(rowToCamel(row) as unknown as RegisteredKey);
  }

  const db = getDbInstance();
  const row = db
    .prepare(
      `
    SELECT * FROM registered_keys
    WHERE key = ? AND is_active = 1
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `
    )
    .get(hash) as RegisteredKeyRow | undefined;
  if (!row) return null;

  // Auto-reset budget windows if needed
  const today = nowDay();
  const hour = nowHour();
  if (row.last_reset_day !== today || row.last_reset_hour !== hour) {
    db.prepare(
      `
      UPDATE registered_keys
      SET daily_used = CASE WHEN last_reset_day <> ? THEN 0 ELSE daily_used END,
          hourly_used = CASE WHEN last_reset_hour <> ? THEN 0 ELSE hourly_used END,
          last_reset_day = ?, last_reset_hour = ?
      WHERE id = ?
    `
    ).run(today, hour, today, hour, row.id);
  }

  // Budget check
  if (row.daily_budget !== null && row.daily_used >= row.daily_budget) return null;
  if (row.hourly_budget !== null && row.hourly_used >= row.hourly_budget) return null;

  return rowToCamel(row) as unknown as RegisteredKey;
}

/**
 * Increment usage counters for a registered key (called by request pipeline).
 */
export async function incrementRegisteredKeyUsage(id: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await sql`
      UPDATE registered_keys
      SET daily_used = daily_used + 1, hourly_used = hourly_used + 1, updated_at = ${new Date().toISOString()}
      WHERE id = ${id}
    `.execute(getKyselyDb());
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `
    UPDATE registered_keys
    SET daily_used = daily_used + 1, hourly_used = hourly_used + 1, updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(id);
}

// ─── Provider / Account Limit Management ──────────────────────────────────────

export async function setProviderKeyLimit(
  provider: string,
  limits: Partial<Omit<ProviderKeyLimit, "provider" | "dailyIssued" | "hourlyIssued" | "updatedAt">>
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    await getKyselyDb()
      .insertInto("provider_key_limits")
      .values({
        provider,
        max_active_keys: limits.maxActiveKeys ?? null,
        daily_issue_limit: limits.dailyIssueLimit ?? null,
        hourly_issue_limit: limits.hourlyIssueLimit ?? null,
        last_reset_day: nowDay(),
        last_reset_hour: nowHour(),
      })
      .onConflict((oc) =>
        oc.column("provider").doUpdateSet({
          max_active_keys: limits.maxActiveKeys ?? null,
          daily_issue_limit: limits.dailyIssueLimit ?? null,
          hourly_issue_limit: limits.hourlyIssueLimit ?? null,
          updated_at: now,
        })
      )
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `
    INSERT INTO provider_key_limits (provider, max_active_keys, daily_issue_limit, hourly_issue_limit, last_reset_day, last_reset_hour)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      max_active_keys = excluded.max_active_keys,
      daily_issue_limit = excluded.daily_issue_limit,
      hourly_issue_limit = excluded.hourly_issue_limit,
      updated_at = datetime('now')
  `
  ).run(
    provider,
    limits.maxActiveKeys ?? null,
    limits.dailyIssueLimit ?? null,
    limits.hourlyIssueLimit ?? null,
    nowDay(),
    nowHour()
  );
}

export async function setAccountKeyLimit(
  accountId: string,
  limits: Partial<Omit<AccountKeyLimit, "accountId" | "dailyIssued" | "hourlyIssued" | "updatedAt">>
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    await getKyselyDb()
      .insertInto("account_key_limits")
      .values({
        account_id: accountId,
        max_active_keys: limits.maxActiveKeys ?? null,
        daily_issue_limit: limits.dailyIssueLimit ?? null,
        hourly_issue_limit: limits.hourlyIssueLimit ?? null,
        last_reset_day: nowDay(),
        last_reset_hour: nowHour(),
      })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          max_active_keys: limits.maxActiveKeys ?? null,
          daily_issue_limit: limits.dailyIssueLimit ?? null,
          hourly_issue_limit: limits.hourlyIssueLimit ?? null,
          updated_at: now,
        })
      )
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `
    INSERT INTO account_key_limits (account_id, max_active_keys, daily_issue_limit, hourly_issue_limit, last_reset_day, last_reset_hour)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      max_active_keys = excluded.max_active_keys,
      daily_issue_limit = excluded.daily_issue_limit,
      hourly_issue_limit = excluded.hourly_issue_limit,
      updated_at = datetime('now')
  `
  ).run(
    accountId,
    limits.maxActiveKeys ?? null,
    limits.dailyIssueLimit ?? null,
    limits.hourlyIssueLimit ?? null,
    nowDay(),
    nowHour()
  );
}

export async function getProviderKeyLimit(provider: string): Promise<ProviderKeyLimit | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("provider_key_limits")
      .selectAll()
      .where("provider", "=", provider)
      .executeTakeFirst();
    return row ? normalizeKeyLimitRow(rowToCamel(row) as unknown as ProviderKeyLimit) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM provider_key_limits WHERE provider = ?").get(provider) as
    ProviderKeyLimitRow | undefined;
  return row ? (rowToCamel(row) as unknown as ProviderKeyLimit) : null;
}

export async function getAccountKeyLimit(accountId: string): Promise<AccountKeyLimit | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("account_key_limits")
      .selectAll()
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return row ? normalizeKeyLimitRow(rowToCamel(row) as unknown as AccountKeyLimit) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM account_key_limits WHERE account_id = ?").get(accountId) as
    AccountKeyLimitRow | undefined;
  return row ? (rowToCamel(row) as unknown as AccountKeyLimit) : null;
}

// ─── Internal types (raw DB rows) ─────────────────────────────────────────────

interface RegisteredKeyRow {
  id: string;
  key: string;
  key_prefix: string;
  name: string;
  provider: string;
  account_id: string;
  is_active: number;
  revoked_at: string | null;
  expires_at: string | null;
  idempotency_key: string | null;
  daily_budget: number | null;
  hourly_budget: number | null;
  daily_used: number;
  hourly_used: number;
  last_reset_day: string;
  last_reset_hour: string;
  created_at: string;
  updated_at: string;
}

interface ProviderKeyLimitRow {
  provider: string;
  max_active_keys: number | null;
  daily_issue_limit: number | null;
  hourly_issue_limit: number | null;
  daily_issued: number;
  hourly_issued: number;
  last_reset_day: string;
  last_reset_hour: string;
  updated_at: string;
}

interface AccountKeyLimitRow {
  account_id: string;
  max_active_keys: number | null;
  daily_issue_limit: number | null;
  hourly_issue_limit: number | null;
  daily_issued: number;
  hourly_issued: number;
  last_reset_day: string;
  last_reset_hour: string;
  updated_at: string;
}
