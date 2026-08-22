/**
 * API Key Groups DB — CRUD operations for team/enterprise key grouping
 *
 * Tables: key_groups, group_model_permissions, key_group_members
 * Migration: 066_api_key_groups.sql
 *
 * Enables team-level API key management with model-level access control.
 */

import { getDbInstance } from "@/lib/db/core";
import { randomUUID } from "crypto";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// Postgres BIGINT columns (is_active) come back as JS strings from
// node-postgres, not numbers — coerce before any boolean check.
function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// ── Types ────────────────────────────────────────────────────────────────

export interface KeyGroup {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupModelPermission {
  id: string;
  groupId: string;
  modelPattern: string;
  provider: string | null;
  accessType: "allow" | "deny";
  createdAt: string;
}

export interface KeyGroupMember {
  keyId: string;
  groupId: string;
  createdAt: string;
}

export interface KeyGroupWithPermissions extends KeyGroup {
  permissions: GroupModelPermission[];
  memberCount: number;
}

// ── Key Groups CRUD ──────────────────────────────────────────────────────

export async function getAllKeyGroups(): Promise<KeyGroup[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("key_groups")
      .selectAll()
      .orderBy("name", "asc")
      .execute();
    return rows.map(rowToGroup);
  }

  const db = getDbInstance() as any;
  const rows = db.prepare("SELECT * FROM key_groups ORDER BY name ASC").all() as any[];
  return rows.map(rowToGroup);
}

export async function getKeyGroup(id: string): Promise<KeyGroup | undefined> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("key_groups")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToGroup(row) : undefined;
  }

  const db = getDbInstance() as any;
  const row = db.prepare("SELECT * FROM key_groups WHERE id = ?").get(id) as any;
  return row ? rowToGroup(row) : undefined;
}

export async function getKeyGroupWithPermissions(
  id: string
): Promise<KeyGroupWithPermissions | undefined> {
  const group = await getKeyGroup(id);
  if (!group) return undefined;

  const permissions = await getGroupPermissions(id);
  const memberCount = await getGroupMemberCount(id);

  return { ...group, permissions, memberCount };
}

export async function createKeyGroup(name: string, description = ""): Promise<KeyGroup> {
  const id = randomUUID();
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_groups")
      .values({ id, name, description, created_at: now, updated_at: now })
      .execute();
    return (await getKeyGroup(id))!;
  }

  const db = getDbInstance() as any;
  db.prepare(
    "INSERT INTO key_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, name, description, now, now);

  return (await getKeyGroup(id))!;
}

export async function updateKeyGroup(
  id: string,
  updates: { name?: string; description?: string; isActive?: boolean }
): Promise<KeyGroup | undefined> {
  const existing = await getKeyGroup(id);
  if (!existing) return undefined;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const set: Record<string, unknown> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.description !== undefined) set.description = updates.description;
    if (updates.isActive !== undefined) set.is_active = updates.isActive ? 1 : 0;

    if (Object.keys(set).length === 0) return existing;
    set.updated_at = new Date().toISOString();

    await getKyselyDb().updateTable("key_groups").set(set).where("id", "=", id).execute();
    return await getKeyGroup(id);
  }

  const db = getDbInstance() as any;
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.name !== undefined) {
    sets.push("name = @name");
    params.name = updates.name;
  }
  if (updates.description !== undefined) {
    sets.push("description = @description");
    params.description = updates.description;
  }
  if (updates.isActive !== undefined) {
    sets.push("is_active = @isActive");
    params.isActive = updates.isActive ? 1 : 0;
  }

  if (sets.length === 0) return existing;
  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE key_groups SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return await getKeyGroup(id);
}

export async function deleteKeyGroup(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    // Postgres bootstrap does not declare FK ON DELETE CASCADE (unlike the
    // SQLite migration), so the dependent rows must be deleted explicitly.
    return await kdb.transaction().execute(async (trx) => {
      await trx.deleteFrom("group_model_permissions").where("group_id", "=", id).execute();
      await trx.deleteFrom("key_group_members").where("group_id", "=", id).execute();
      const result = await trx.deleteFrom("key_groups").where("id", "=", id).executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
  }

  const db = getDbInstance() as any;
  // CASCADE deletes permissions and members
  const result = db.prepare("DELETE FROM key_groups WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Group Permissions ────────────────────────────────────────────────────

export async function getGroupPermissions(groupId: string): Promise<GroupModelPermission[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("group_model_permissions")
      .selectAll()
      .where("group_id", "=", groupId)
      .orderBy("access_type", "asc")
      .orderBy("model_pattern", "asc")
      .execute();
    return rows.map(rowToPermission);
  }

  const db = getDbInstance() as any;
  const rows = db
    .prepare(
      "SELECT * FROM group_model_permissions WHERE group_id = ? ORDER BY access_type ASC, model_pattern ASC"
    )
    .all(groupId) as any[];
  return rows.map(rowToPermission);
}

export async function addGroupPermission(
  groupId: string,
  modelPattern: string,
  accessType: "allow" | "deny",
  provider?: string
): Promise<GroupModelPermission> {
  const id = randomUUID();
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("group_model_permissions")
      .values({
        id,
        group_id: groupId,
        model_pattern: modelPattern,
        provider: provider || null,
        access_type: accessType,
        created_at: now,
      })
      .execute();
    return (await getGroupPermissions(groupId)).find((p) => p.id === id)!;
  }

  const db = getDbInstance() as any;
  db.prepare(
    "INSERT INTO group_model_permissions (id, group_id, model_pattern, provider, access_type, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, groupId, modelPattern, provider || null, accessType, now);

  return (await getGroupPermissions(groupId)).find((p) => p.id === id)!;
}

export async function removeGroupPermission(permissionId: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("group_model_permissions")
      .where("id", "=", permissionId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance() as any;
  const result = db.prepare("DELETE FROM group_model_permissions WHERE id = ?").run(permissionId);
  return result.changes > 0;
}

export async function clearGroupPermissions(groupId: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("group_model_permissions")
      .where("group_id", "=", groupId)
      .execute();
    return;
  }

  const db = getDbInstance() as any;
  db.prepare("DELETE FROM group_model_permissions WHERE group_id = ?").run(groupId);
}

// ── Key Group Members ────────────────────────────────────────────────────

export async function getGroupMembers(groupId: string): Promise<KeyGroupMember[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("key_group_members")
      .selectAll()
      .where("group_id", "=", groupId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(rowToMember);
  }

  const db = getDbInstance() as any;
  const rows = db
    .prepare("SELECT * FROM key_group_members WHERE group_id = ? ORDER BY created_at ASC")
    .all(groupId) as any[];
  return rows.map(rowToMember);
}

export async function getKeyGroupsForApiKey(keyId: string): Promise<KeyGroup[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("key_groups")
      .innerJoin("key_group_members", "key_group_members.group_id", "key_groups.id")
      .selectAll("key_groups")
      .where("key_group_members.key_id", "=", keyId)
      .where("key_groups.is_active", "=", 1)
      .orderBy("key_groups.name", "asc")
      .execute();
    return rows.map(rowToGroup);
  }

  const db = getDbInstance() as any;
  const rows = db
    .prepare(
      `
    SELECT g.* FROM key_groups g
    INNER JOIN key_group_members m ON g.id = m.group_id
    WHERE m.key_id = ? AND g.is_active = 1
    ORDER BY g.name ASC
  `
    )
    .all(keyId) as any[];
  return rows.map(rowToGroup);
}

export async function addKeyToGroup(keyId: string, groupId: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    try {
      await getKyselyDb()
        .insertInto("key_group_members")
        .values({ key_id: keyId, group_id: groupId })
        .onConflict((oc) => oc.columns(["key_id", "group_id"]).doNothing())
        .execute();
      return true;
    } catch {
      return false;
    }
  }

  const db = getDbInstance() as any;
  try {
    db.prepare("INSERT OR IGNORE INTO key_group_members (key_id, group_id) VALUES (?, ?)").run(
      keyId,
      groupId
    );
    return true;
  } catch {
    return false;
  }
}

export async function removeKeyFromGroup(keyId: string, groupId: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("key_group_members")
      .where("key_id", "=", keyId)
      .where("group_id", "=", groupId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance() as any;
  const result = db
    .prepare("DELETE FROM key_group_members WHERE key_id = ? AND group_id = ?")
    .run(keyId, groupId);
  return result.changes > 0;
}

async function getGroupMemberCount(groupId: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("key_group_members")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("group_id", "=", groupId)
      .executeTakeFirst();
    return row ? toInt(row.count) : 0;
  }

  const db = getDbInstance() as any;
  const row = db
    .prepare("SELECT COUNT(*) as count FROM key_group_members WHERE group_id = ?")
    .get(groupId) as any;
  return row?.count || 0;
}

// ── Authorization Helper ────────────────────────────────────────────────

export interface ModelAccessCheck {
  allowed: boolean;
  matchedRules: GroupModelPermission[];
  deniedBy: GroupModelPermission | null;
}

/**
 * Check if an API key has access to a specific model.
 * Deny rules override allow rules. If no rules match, access is allowed by default.
 */
export async function checkKeyModelAccess(
  keyId: string,
  model: string,
  provider?: string
): Promise<ModelAccessCheck> {
  const groups = await getKeyGroupsForApiKey(keyId);
  if (groups.length === 0) {
    // No groups = no restrictions
    return { allowed: true, matchedRules: [], deniedBy: null };
  }

  const groupIds = groups.map((g) => g.id);

  let rules: any[];
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    rules = await getKyselyDb()
      .selectFrom("group_model_permissions")
      .selectAll()
      .where("group_id", "in", groupIds)
      .orderBy("access_type", "asc")
      .execute();
  } else {
    const db = getDbInstance() as any;
    const placeholders = groupIds.map(() => "?").join(",");
    rules = db
      .prepare(
        `
      SELECT * FROM group_model_permissions
      WHERE group_id IN (${placeholders})
      ORDER BY access_type ASC
    `
      )
      .all(...groupIds) as any[];
  }

  const permissions = rules.map(rowToPermission);

  // Check deny rules first (they take precedence)
  const denyRules = permissions.filter(
    (p) =>
      p.accessType === "deny" &&
      matchesModelPattern(p.modelPattern, model) &&
      (!p.provider || p.provider === provider)
  );

  if (denyRules.length > 0) {
    return { allowed: false, matchedRules: permissions, deniedBy: denyRules[0] };
  }

  // Check allow rules
  const allowRules = permissions.filter(
    (p) =>
      p.accessType === "allow" &&
      matchesModelPattern(p.modelPattern, model) &&
      (!p.provider || p.provider === provider)
  );

  if (allowRules.length > 0) {
    return { allowed: true, matchedRules: permissions, deniedBy: null };
  }

  // No matching rules = restricted by group membership but no explicit allow
  return { allowed: false, matchedRules: permissions, deniedBy: null };
}

function matchesModelPattern(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(model);
  }
  return pattern === model;
}

// ── Row Mappers ──────────────────────────────────────────────────────────

function rowToGroup(row: any): KeyGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    isActive: toInt(row.is_active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPermission(row: any): GroupModelPermission {
  return {
    id: row.id,
    groupId: row.group_id,
    modelPattern: row.model_pattern,
    provider: row.provider || null,
    accessType: row.access_type,
    createdAt: row.created_at,
  };
}

function rowToMember(row: any): KeyGroupMember {
  return {
    keyId: row.key_id,
    groupId: row.group_id,
    createdAt: row.created_at,
  };
}
