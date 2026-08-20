/**
 * gamification.ts — DB domain module for the Gamification & Leaderboard system.
 *
 * Manages leaderboards, XP/levels, badges, token ledger, invite tokens,
 * and community server connections.
 */

import { getDbInstance } from "./core";
import { calculateLevel } from "../gamification/xp";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./kysely/types";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// ──────────────── Types ────────────────

export interface LeaderboardRow {
  apiKeyId: string;
  scope: string;
  score: number;
  updatedAt: string;
}

export interface UserLevelRow {
  apiKeyId: string;
  totalXp: number;
  currentLevel: number;
  updatedAt: string;
}

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  rarity: string;
  criteria: string | null;
  hidden: number;
  createdAt: string;
}

export interface UserBadge {
  apiKeyId: string;
  badgeId: string;
  unlockedAt: string;
  badgeName?: string;
  badgeDescription?: string | null;
  badgeIcon?: string | null;
  badgeCategory?: string | null;
  badgeRarity?: string;
}

export interface XpAuditLogEntry {
  id: number;
  apiKeyId: string;
  action: string;
  xpEarned: number;
  metadata: string | null;
  createdAt: string;
}

export interface TokenLedgerEntry {
  id: number;
  fromApiKeyId: string;
  toApiKeyId: string;
  amount: number;
  reason: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface InviteToken {
  id: string;
  code: string;
  tokenHash: string;
  createdBy: string;
  usedBy: string | null;
  serverUrl: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CommunityServer {
  id: string;
  name: string;
  url: string;
  apiKeyHash: string;
  connectedAt: string;
  lastSyncAt: string | null;
  status: string;
  errorMessage: string | null;
}

// ──────────────── Helper ────────────────

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

function db(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

// ──────────────── Leaderboard ────────────────

export async function updateScore(apiKeyId: string, scope: string, points: number): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    await getKyselyDb()
      .insertInto("leaderboard")
      .values({ api_key_id: apiKeyId, scope, score: points, updated_at: now })
      .onConflict((oc) =>
        oc.columns(["api_key_id", "scope"]).doUpdateSet({
          score: (eb) => eb("leaderboard.score", "+", points),
          updated_at: now,
        })
      )
      .execute();
    return;
  }

  db()
    .prepare(
      `INSERT INTO leaderboard (api_key_id, scope, score, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(api_key_id, scope)
     DO UPDATE SET score = score + excluded.score, updated_at = datetime('now')`
    )
    .run(apiKeyId, scope, points);
}

export async function getRank(apiKeyId: string, scope: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("leaderboard")
      .select("score")
      .where("api_key_id", "=", apiKeyId)
      .where("scope", "=", scope)
      .executeTakeFirst();
    if (!row) return 0;
    const rankRow = await kdb
      .selectFrom("leaderboard")
      .select((eb) => eb.fn.countAll().as("rank"))
      .where("scope", "=", scope)
      .where("score", ">", row.score)
      .executeTakeFirst();
    return Number(rankRow?.rank ?? 0) + 1;
  }

  const row = db()
    .prepare(`SELECT score FROM leaderboard WHERE api_key_id = ? AND scope = ?`)
    .get(apiKeyId, scope) as { score: number } | undefined;
  if (!row) return 0;
  const rankRow = db()
    .prepare(`SELECT COUNT(*) + 1 AS rank FROM leaderboard WHERE scope = ? AND score > ?`)
    .get(scope, row.score) as { rank: number };
  return rankRow.rank;
}

export async function getTopN(
  scope: string,
  limit: number,
  offset: number = 0
): Promise<LeaderboardRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("leaderboard")
      .select(["api_key_id", "scope", "score", "updated_at"])
      .where("scope", "=", scope)
      .orderBy("score", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map((r) => ({
      apiKeyId: r.api_key_id,
      scope: r.scope,
      score: Number(r.score),
      updatedAt: r.updated_at,
    }));
  }

  const rows = db()
    .prepare(
      `SELECT api_key_id, scope, score, updated_at FROM leaderboard
     WHERE scope = ? ORDER BY score DESC LIMIT ? OFFSET ?`
    )
    .all(scope, limit, offset) as Array<{
    api_key_id: string;
    scope: string;
    score: number;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    apiKeyId: r.api_key_id,
    scope: r.scope,
    score: r.score,
    updatedAt: r.updated_at,
  }));
}

// ──────────────── XP & Levels ────────────────

export async function addXp(
  apiKeyId: string,
  action: string,
  amount: number,
  metadata?: string
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("xp_audit_log")
      .values({ api_key_id: apiKeyId, action, xp_earned: amount, metadata: metadata ?? null })
      .execute();
    await kdb
      .insertInto("user_levels")
      .values({
        api_key_id: apiKeyId,
        total_xp: amount,
        current_level: calculateLevel(amount),
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("api_key_id").doUpdateSet({
          total_xp: (eb) => eb("user_levels.total_xp", "+", amount),
          updated_at: now,
        })
      )
      .execute();
    return;
  }

  db()
    .prepare(
      `INSERT INTO xp_audit_log (api_key_id, action, xp_earned, metadata)
     VALUES (?, ?, ?, ?)`
    )
    .run(apiKeyId, action, amount, metadata ?? null);

  db()
    .prepare(
      `INSERT INTO user_levels (api_key_id, total_xp, current_level, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(api_key_id)
     DO UPDATE SET total_xp = total_xp + excluded.total_xp, updated_at = datetime('now')`
    )
    .run(apiKeyId, amount, calculateLevel(amount));
}

export async function getXp(apiKeyId: string): Promise<UserLevelRow | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("user_levels")
      .select(["api_key_id", "total_xp", "current_level", "updated_at"])
      .where("api_key_id", "=", apiKeyId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      apiKeyId: row.api_key_id,
      totalXp: Number(row.total_xp),
      currentLevel: Number(row.current_level),
      updatedAt: row.updated_at,
    };
  }

  const row = db()
    .prepare(
      `SELECT api_key_id, total_xp, current_level, updated_at FROM user_levels WHERE api_key_id = ?`
    )
    .get(apiKeyId) as
    | {
        api_key_id: string;
        total_xp: number;
        current_level: number;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    apiKeyId: row.api_key_id,
    totalXp: row.total_xp,
    currentLevel: row.current_level,
    updatedAt: row.updated_at,
  };
}

export async function updateLevel(apiKeyId: string, level: number): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    await getKyselyDb()
      .insertInto("user_levels")
      .values({ api_key_id: apiKeyId, total_xp: 0, current_level: level, updated_at: now })
      .onConflict((oc) =>
        oc.column("api_key_id").doUpdateSet({ current_level: level, updated_at: now })
      )
      .execute();
    return;
  }

  db()
    .prepare(
      `INSERT INTO user_levels (api_key_id, total_xp, current_level, updated_at)
     VALUES (?, 0, ?, datetime('now'))
     ON CONFLICT(api_key_id)
     DO UPDATE SET current_level = ?, updated_at = datetime('now')`
    )
    .run(apiKeyId, level, level);
}

// ──────────────── Badges ────────────────

export async function unlockBadge(apiKeyId: string, badgeId: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("user_badges")
      .values({ api_key_id: apiKeyId, badge_id: badgeId })
      .onConflict((oc) => oc.columns(["api_key_id", "badge_id"]).doNothing())
      .execute();
    return;
  }

  db()
    .prepare(`INSERT OR IGNORE INTO user_badges (api_key_id, badge_id) VALUES (?, ?)`)
    .run(apiKeyId, badgeId);
}

/**
 * Whether a specific badge has already been awarded to an API key.
 *
 * Reads `user_badges` directly (no JOIN), so the "already unlocked?" check is correct even
 * when `badge_definitions` is unpopulated. `getBadges()` INNER-JOINs `badge_definitions`, so
 * it returns nothing until the definitions are seeded — using it as a dedup guard caused
 * badge-unlock events to re-fire on every request (#3472).
 */
export async function hasBadge(apiKeyId: string, badgeId: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("user_badges")
      .select("api_key_id")
      .where("api_key_id", "=", apiKeyId)
      .where("badge_id", "=", badgeId)
      .executeTakeFirst();
    return !!row;
  }

  const row = db()
    .prepare(`SELECT 1 FROM user_badges WHERE api_key_id = ? AND badge_id = ? LIMIT 1`)
    .get(apiKeyId, badgeId);
  return !!row;
}

export async function getBadges(apiKeyId: string): Promise<UserBadge[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("user_badges as ub")
      .innerJoin("badge_definitions as bd", "bd.id", "ub.badge_id")
      .select([
        "ub.api_key_id",
        "ub.badge_id",
        "ub.unlocked_at",
        "bd.name",
        "bd.description",
        "bd.icon",
        "bd.category",
        "bd.rarity",
      ])
      .where("ub.api_key_id", "=", apiKeyId)
      .execute();
    return rows.map((r) => ({
      apiKeyId: r.api_key_id,
      badgeId: r.badge_id,
      unlockedAt: r.unlocked_at,
      badgeName: r.name,
      badgeDescription: r.description,
      badgeIcon: r.icon,
      badgeCategory: r.category,
      badgeRarity: r.rarity,
    }));
  }

  const rows = db()
    .prepare(
      `SELECT ub.api_key_id, ub.badge_id, ub.unlocked_at,
            bd.name, bd.description, bd.icon, bd.category, bd.rarity
     FROM user_badges ub
     JOIN badge_definitions bd ON bd.id = ub.badge_id
     WHERE ub.api_key_id = ?`
    )
    .all(apiKeyId) as Array<{
    api_key_id: string;
    badge_id: string;
    unlocked_at: string;
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    rarity: string;
  }>;
  return rows.map((r) => ({
    apiKeyId: r.api_key_id,
    badgeId: r.badge_id,
    unlockedAt: r.unlocked_at,
    badgeName: r.name,
    badgeDescription: r.description,
    badgeIcon: r.icon,
    badgeCategory: r.category,
    badgeRarity: r.rarity,
  }));
}

export async function getBadgeDefinitions(category?: string): Promise<BadgeDefinition[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().selectFrom("badge_definitions").selectAll();
    if (category) query = query.where("category", "=", category);
    const rows = await query.execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      icon: r.icon,
      category: r.category,
      rarity: r.rarity,
      criteria: r.criteria,
      hidden: Number(r.hidden),
      createdAt: r.created_at,
    }));
  }

  const sqlStr = category
    ? `SELECT * FROM badge_definitions WHERE category = ?`
    : `SELECT * FROM badge_definitions`;
  const rows = (
    category ? db().prepare(sqlStr).all(category) : db().prepare(sqlStr).all()
  ) as Array<{
    id: string;
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    rarity: string;
    criteria: string | null;
    hidden: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    category: r.category,
    rarity: r.rarity,
    criteria: r.criteria,
    hidden: r.hidden,
    createdAt: r.created_at,
  }));
}

/**
 * Aggregate XP across every API key (the operator-wide profile view used by the
 * dashboard profile page, which is not scoped to a single key). Sums total XP and
 * takes the highest reached level. (#3484)
 */
export async function getAggregateXp(): Promise<UserLevelRow> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("user_levels")
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum("total_xp"), eb.lit(0)).as("total_xp"),
        eb.fn.coalesce(eb.fn.max("current_level"), eb.lit(1)).as("current_level"),
        eb.fn.max("updated_at").as("updated_at"),
      ])
      .executeTakeFirst();
    return {
      apiKeyId: "*",
      totalXp: Number(row?.total_xp ?? 0),
      currentLevel: Number(row?.current_level ?? 1),
      updatedAt: row?.updated_at ?? "",
    };
  }

  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(total_xp), 0) AS total_xp,
              COALESCE(MAX(current_level), 1) AS current_level,
              MAX(updated_at) AS updated_at
       FROM user_levels`
    )
    .get() as { total_xp: number; current_level: number; updated_at: string | null };
  return {
    apiKeyId: "*",
    totalXp: row?.total_xp ?? 0,
    currentLevel: row?.current_level ?? 1,
    updatedAt: row?.updated_at ?? "",
  };
}

/**
 * Distinct badges earned by any API key (operator-wide earned set for the profile
 * page). Deduplicated by badge id, keeping the earliest unlock. (#3484)
 */
export async function getAllEarnedBadges(): Promise<UserBadge[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    // GROUP BY bd.id (not ub.badge_id) — Postgres only recognizes the
    // ungrouped bd.* columns below as functionally dependent when the
    // GROUP BY key is that table's own primary key.
    const rows = await getKyselyDb()
      .selectFrom("user_badges as ub")
      .innerJoin("badge_definitions as bd", "bd.id", "ub.badge_id")
      .select((eb) => [
        "bd.id as badge_id",
        eb.fn.min("ub.unlocked_at").as("unlocked_at"),
        "bd.name",
        "bd.description",
        "bd.icon",
        "bd.category",
        "bd.rarity",
      ])
      .groupBy("bd.id")
      .execute();
    return rows.map((r) => ({
      apiKeyId: "*",
      badgeId: r.badge_id,
      unlockedAt: r.unlocked_at,
      badgeName: r.name,
      badgeDescription: r.description,
      badgeIcon: r.icon,
      badgeCategory: r.category,
      badgeRarity: r.rarity,
    }));
  }

  const rows = db()
    .prepare(
      `SELECT ub.badge_id, MIN(ub.unlocked_at) AS unlocked_at,
              bd.name, bd.description, bd.icon, bd.category, bd.rarity
       FROM user_badges ub
       JOIN badge_definitions bd ON bd.id = ub.badge_id
       GROUP BY ub.badge_id`
    )
    .all() as Array<{
    badge_id: string;
    unlocked_at: string;
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    rarity: string;
  }>;
  return rows.map((r) => ({
    apiKeyId: "*",
    badgeId: r.badge_id,
    unlockedAt: r.unlocked_at,
    badgeName: r.name,
    badgeDescription: r.description,
    badgeIcon: r.icon,
    badgeCategory: r.category,
    badgeRarity: r.rarity,
  }));
}

// ──────────────── Token Ledger ────────────────

/** Balance query shared by getBalance() and the transferTokens() transaction — works against either the top-level Kysely connection or an open Transaction. */
async function pgGetBalance(
  kdb: Kysely<Database> | Transaction<Database>,
  apiKeyId: string
): Promise<number> {
  const received = await kdb
    .selectFrom("token_ledger")
    .select((eb) => eb.fn.coalesce(eb.fn.sum("amount"), eb.lit(0)).as("total"))
    .where("to_api_key_id", "=", apiKeyId)
    .executeTakeFirst();
  const sent = await kdb
    .selectFrom("token_ledger")
    .select((eb) => eb.fn.coalesce(eb.fn.sum("amount"), eb.lit(0)).as("total"))
    .where("from_api_key_id", "=", apiKeyId)
    .executeTakeFirst();
  return Number(received?.total ?? 0) - Number(sent?.total ?? 0);
}

function getBalanceSync(apiKeyId: string): number {
  const received = db()
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM token_ledger WHERE to_api_key_id = ?`)
    .get(apiKeyId) as { total: number };
  const sent = db()
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM token_ledger WHERE from_api_key_id = ?`)
    .get(apiKeyId) as { total: number };
  return received.total - sent.total;
}

export async function transferTokens(
  fromId: string,
  toId: string,
  amount: number,
  reason: string,
  idempotencyKey: string
): Promise<{ success: boolean; error?: string }> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    return getKyselyDb()
      .transaction()
      .execute(async (trx) => {
        // Check for duplicate
        const existing = await trx
          .selectFrom("token_ledger")
          .select("id")
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (existing) return { success: true };

        // Balance check (inside transaction to prevent race)
        const balance = await pgGetBalance(trx, fromId);
        if (balance < amount) {
          return { success: false, error: "insufficient_balance" };
        }

        await trx
          .insertInto("token_ledger")
          .values({
            from_api_key_id: fromId,
            to_api_key_id: toId,
            amount,
            reason,
            idempotency_key: idempotencyKey,
          })
          .execute();

        return { success: true };
      });
  }

  // Atomic transaction: balance check + insert
  const instance = getDbInstance();
  const txn = instance.transaction(() => {
    // Check for duplicate
    const existing = instance
      .prepare(`SELECT id FROM token_ledger WHERE idempotency_key = ?`)
      .get(idempotencyKey) as { id: number } | undefined;
    if (existing) return { success: true };

    // Balance check (inside transaction to prevent race)
    const balance = getBalanceSync(fromId);
    if (balance < amount) {
      return { success: false, error: "insufficient_balance" };
    }

    instance
      .prepare(
        `INSERT INTO token_ledger (from_api_key_id, to_api_key_id, amount, reason, idempotency_key)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(fromId, toId, amount, reason, idempotencyKey);

    return { success: true };
  });

  return txn();
}

export async function getBalance(apiKeyId: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    return pgGetBalance(getKyselyDb(), apiKeyId);
  }
  return getBalanceSync(apiKeyId);
}

export async function getHistory(apiKeyId: string, limit: number): Promise<TokenLedgerEntry[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("token_ledger")
      .selectAll()
      .where((eb) =>
        eb.or([eb("from_api_key_id", "=", apiKeyId), eb("to_api_key_id", "=", apiKeyId)])
      )
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: Number(r.id),
      fromApiKeyId: r.from_api_key_id,
      toApiKeyId: r.to_api_key_id,
      amount: Number(r.amount),
      reason: r.reason,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at,
    }));
  }

  const rows = db()
    .prepare(
      `SELECT * FROM token_ledger
     WHERE from_api_key_id = ? OR to_api_key_id = ?
     ORDER BY created_at DESC LIMIT ?`
    )
    .all(apiKeyId, apiKeyId, limit) as Array<{
    id: number;
    from_api_key_id: string;
    to_api_key_id: string;
    amount: number;
    reason: string | null;
    idempotency_key: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    fromApiKeyId: r.from_api_key_id,
    toApiKeyId: r.to_api_key_id,
    amount: r.amount,
    reason: r.reason,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  }));
}

// ──────────────── Invite Tokens ────────────────

export async function createInviteToken(
  id: string,
  code: string,
  tokenHash: string,
  createdBy: string,
  serverUrl?: string,
  maxUses?: number
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("invite_tokens")
      .values({
        id,
        code,
        token_hash: tokenHash,
        created_by: createdBy,
        server_url: serverUrl ?? null,
        max_uses: maxUses ?? 1,
      })
      .execute();
    return;
  }

  db()
    .prepare(
      `INSERT INTO invite_tokens (id, code, token_hash, created_by, server_url, max_uses)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, code, tokenHash, createdBy, serverUrl ?? null, maxUses ?? 1);
}

export async function getInviteByCode(code: string): Promise<InviteToken | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("invite_tokens")
      .selectAll()
      .where("code", "=", code)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      code: row.code,
      tokenHash: row.token_hash,
      createdBy: row.created_by,
      usedBy: row.used_by,
      serverUrl: row.server_url,
      maxUses: Number(row.max_uses),
      useCount: Number(row.use_count),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }

  const row = db().prepare(`SELECT * FROM invite_tokens WHERE code = ?`).get(code) as
    | {
        id: string;
        code: string;
        token_hash: string;
        created_by: string;
        used_by: string | null;
        server_url: string | null;
        max_uses: number;
        use_count: number;
        expires_at: string | null;
        revoked_at: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    tokenHash: row.token_hash,
    createdBy: row.created_by,
    usedBy: row.used_by,
    serverUrl: row.server_url,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export async function redeemInvite(code: string, usedBy: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    const result = await getKyselyDb()
      .updateTable("invite_tokens")
      .set({
        use_count: (eb) => eb("invite_tokens.use_count", "+", 1),
        used_by: usedBy,
      })
      .where("code", "=", code)
      .where("revoked_at", "is", null)
      .where((eb) => eb("use_count", "<", eb.ref("max_uses")))
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  const result = db()
    .prepare(
      `UPDATE invite_tokens
     SET use_count = use_count + 1, used_by = ?
     WHERE code = ? AND revoked_at IS NULL
       AND use_count < max_uses
       AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .run(usedBy, code);
  return result.changes > 0;
}

export async function revokeInvite(id: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    await getKyselyDb()
      .updateTable("invite_tokens")
      .set({ revoked_at: now })
      .where("id", "=", id)
      .execute();
    return;
  }

  db().prepare(`UPDATE invite_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(id);
}

// ──────────────── Community Servers ────────────────

/**
 * Look up a connected community server by its API key hash.
 * Returns the server id if the key hash matches a 'connected' server, or undefined.
 * Used by federation routes to authenticate bearer tokens.
 */
export async function getConnectedServerByKeyHash(
  apiKeyHash: string
): Promise<{ id: string } | undefined> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    return getKyselyDb()
      .selectFrom("community_servers")
      .select("id")
      .where("api_key_hash", "=", apiKeyHash)
      .where("status", "=", "connected")
      .executeTakeFirst();
  }

  return db()
    .prepare("SELECT id FROM community_servers WHERE api_key_hash = ? AND status = 'connected'")
    .get(apiKeyHash) as { id: string } | undefined;
}

export async function connectServer(
  id: string,
  name: string,
  url: string,
  apiKeyHash: string
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const now = new Date().toISOString();
    // Mirrors SQLite's INSERT OR REPLACE: a conflicting row is fully reset,
    // not merged — unlisted columns go back to their defaults, not preserved.
    await getKyselyDb()
      .insertInto("community_servers")
      .values({ id, name, url, api_key_hash: apiKeyHash, connected_at: now })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          name,
          url,
          api_key_hash: apiKeyHash,
          connected_at: now,
          last_sync_at: null,
          status: "connected",
          error_message: null,
        })
      )
      .execute();
    return;
  }

  db()
    .prepare(
      `INSERT OR REPLACE INTO community_servers (id, name, url, api_key_hash)
     VALUES (?, ?, ?, ?)`
    )
    .run(id, name, url, apiKeyHash);
}

export async function disconnectServer(id: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("community_servers")
      .set({ status: "disconnected" })
      .where("id", "=", id)
      .execute();
    return;
  }

  db().prepare(`UPDATE community_servers SET status = 'disconnected' WHERE id = ?`).run(id);
}

/** List community servers (excludes api_key_hash for security). */
export async function listServers(): Promise<Omit<CommunityServer, "apiKeyHash">[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("community_servers")
      .select(["id", "name", "url", "connected_at", "last_sync_at", "status", "error_message"])
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      connectedAt: r.connected_at,
      lastSyncAt: r.last_sync_at,
      status: r.status,
      errorMessage: r.error_message,
    }));
  }

  const rows = db()
    .prepare(
      `SELECT id, name, url, connected_at, last_sync_at, status, error_message FROM community_servers`
    )
    .all() as Array<{
    id: string;
    name: string;
    url: string;
    connected_at: string;
    last_sync_at: string | null;
    status: string;
    error_message: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    connectedAt: r.connected_at,
    lastSyncAt: r.last_sync_at,
    status: r.status,
    errorMessage: r.error_message,
  }));
}

/**
 * Get neighbors around a user on the leaderboard.
 */
export async function getLeaderboardNeighbors(
  apiKeyId: string,
  scope: string,
  radius: number = 5
): Promise<{
  above: Array<{ apiKeyId: string; score: number }>;
  below: Array<{ apiKeyId: string; score: number }>;
}> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const scoreRow = await kdb
      .selectFrom("leaderboard")
      .select("score")
      .where("api_key_id", "=", apiKeyId)
      .where("scope", "=", scope)
      .executeTakeFirst();
    if (!scoreRow) return { above: [], below: [] };

    const above = await kdb
      .selectFrom("leaderboard")
      .select(["api_key_id", "score"])
      .where("scope", "=", scope)
      .where("score", ">", scoreRow.score)
      .orderBy("score", "asc")
      .limit(radius)
      .execute();

    const below = await kdb
      .selectFrom("leaderboard")
      .select(["api_key_id", "score"])
      .where("scope", "=", scope)
      .where("score", "<", scoreRow.score)
      .orderBy("score", "desc")
      .limit(radius)
      .execute();

    return {
      above: above.reverse().map((r) => ({ apiKeyId: r.api_key_id, score: Number(r.score) })),
      below: below.map((r) => ({ apiKeyId: r.api_key_id, score: Number(r.score) })),
    };
  }

  const d = db();

  const scoreRow = d
    .prepare("SELECT score FROM leaderboard WHERE api_key_id = ? AND scope = ?")
    .get(apiKeyId, scope) as { score: number } | undefined;

  if (!scoreRow) return { above: [], below: [] };

  const above = d
    .prepare(
      `SELECT api_key_id, score FROM leaderboard
       WHERE scope = ? AND score > ?
       ORDER BY score ASC LIMIT ?`
    )
    .all(scope, scoreRow.score, radius) as Array<{ api_key_id: string; score: number }>;

  const below = d
    .prepare(
      `SELECT api_key_id, score FROM leaderboard
       WHERE scope = ? AND score < ?
       ORDER BY score DESC LIMIT ?`
    )
    .all(scope, scoreRow.score, radius) as Array<{ api_key_id: string; score: number }>;

  return {
    above: above.reverse().map((r) => ({ apiKeyId: r.api_key_id, score: r.score })),
    below: below.map((r) => ({ apiKeyId: r.api_key_id, score: r.score })),
  };
}

/**
 * Rotate weekly/monthly scopes. Archive old data, reset current.
 * Uses two-step approach (SELECT then parameterized INSERT) to avoid SQL injection.
 * Skips if archive scope already has data for this period (double-run protection).
 */
export async function rotateLeaderboardScope(scope: "weekly" | "monthly"): Promise<void> {
  const archiveSuffix =
    scope === "weekly"
      ? `week_${new Date().toISOString().slice(0, 10)}`
      : `month_${new Date().toISOString().slice(0, 7)}`;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    // Double-run protection: skip if archive scope already has data
    const existing = await kdb
      .selectFrom("leaderboard")
      .select((eb) => eb.fn.countAll().as("cnt"))
      .where("scope", "=", archiveSuffix)
      .executeTakeFirst();
    if (Number(existing?.cnt ?? 0) > 0) return;

    // Step 1: SELECT rows into memory
    const rows = await kdb
      .selectFrom("leaderboard")
      .select(["api_key_id", "score", "updated_at"])
      .where("scope", "=", scope)
      .execute();

    // Step 2: INSERT with parameters (no string interpolation)
    if (rows.length > 0) {
      await kdb
        .insertInto("leaderboard")
        .values(
          rows.map((row) => ({
            api_key_id: row.api_key_id,
            scope: archiveSuffix,
            score: row.score,
            updated_at: row.updated_at,
          }))
        )
        .onConflict((oc) => oc.columns(["api_key_id", "scope"]).doNothing())
        .execute();
    }

    await kdb.deleteFrom("leaderboard").where("scope", "=", scope).execute();
    return;
  }

  const d = db();

  // Double-run protection: skip if archive scope already has data
  const existing = d
    .prepare("SELECT COUNT(*) AS cnt FROM leaderboard WHERE scope = ?")
    .get(archiveSuffix) as { cnt: number };
  if (existing.cnt > 0) return;

  // Step 1: SELECT rows into memory
  const rows = d
    .prepare("SELECT api_key_id, score, updated_at FROM leaderboard WHERE scope = ?")
    .all(scope) as Array<{ api_key_id: string; score: number; updated_at: string }>;

  // Step 2: INSERT with parameters (no string interpolation)
  if (rows.length > 0) {
    const insert = d.prepare(
      "INSERT OR IGNORE INTO leaderboard (api_key_id, scope, score, updated_at) VALUES (?, ?, ?, ?)"
    );
    for (const row of rows) {
      insert.run(row.api_key_id, archiveSuffix, row.score, row.updated_at);
    }
  }

  d.prepare("DELETE FROM leaderboard WHERE scope = ?").run(scope);
}
