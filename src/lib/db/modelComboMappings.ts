/**
 * db/modelComboMappings.ts — Per-model combo mapping CRUD + resolution.
 *
 * Maps model name patterns (glob-style wildcards) to specific combos.
 * When a request arrives for a model string like "claude-sonnet-4",
 * the resolver checks all enabled mappings (highest priority first)
 * and returns the first matching combo.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ModelComboMapping {
  id: string;
  pattern: string;
  comboId: string;
  comboName?: string;
  priority: number;
  enabled: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface MappingRow {
  id: string;
  pattern: string;
  combo_id: string;
  combo_name?: string;
  priority: number;
  enabled: number;
  description: string;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────
// Glob → RegExp conversion
// ─────────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `*` (any characters) and `?` (single character).
 * Case-insensitive matching.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials
    .replace(/\*/g, ".*") // * → .*
    .replace(/\?/g, "."); // ? → .
  return new RegExp(`^${escaped}$`, "i");
}

// ─────────────────────────────────────────────────────────────
// Row mapping
// ─────────────────────────────────────────────────────────────

function rowToMapping(row: MappingRow): ModelComboMapping {
  return {
    id: row.id,
    pattern: row.pattern,
    comboId: row.combo_id,
    comboName: row.combo_name || undefined,
    priority: Number(row.priority),
    enabled: Number(row.enabled) === 1,
    description: row.description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

/**
 * List all model-combo mappings, joined with combo name.
 * Ordered by priority descending (highest first).
 */
export async function getModelComboMappings(): Promise<ModelComboMapping[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("model_combo_mappings as m")
      .leftJoin("combos as c", "c.id", "m.combo_id")
      .select([
        "m.id",
        "m.pattern",
        "m.combo_id",
        "c.name as combo_name",
        "m.priority",
        "m.enabled",
        "m.description",
        "m.created_at",
        "m.updated_at",
      ])
      .orderBy("m.priority", "desc")
      .orderBy("m.created_at", "asc")
      .execute();
    return rows.map((r) => rowToMapping(r as unknown as MappingRow));
  }

  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT m.id, m.pattern, m.combo_id, c.name AS combo_name,
              m.priority, m.enabled, m.description,
              m.created_at, m.updated_at
       FROM model_combo_mappings m
       LEFT JOIN combos c ON c.id = m.combo_id
       ORDER BY m.priority DESC, m.created_at ASC`
    )
    .all() as MappingRow[];
  return rows.map(rowToMapping);
}

/**
 * Get a single mapping by ID.
 */
export async function getModelComboMappingById(id: string): Promise<ModelComboMapping | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("model_combo_mappings as m")
      .leftJoin("combos as c", "c.id", "m.combo_id")
      .select([
        "m.id",
        "m.pattern",
        "m.combo_id",
        "c.name as combo_name",
        "m.priority",
        "m.enabled",
        "m.description",
        "m.created_at",
        "m.updated_at",
      ])
      .where("m.id", "=", id)
      .executeTakeFirst();
    return row ? rowToMapping(row as unknown as MappingRow) : null;
  }

  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT m.id, m.pattern, m.combo_id, c.name AS combo_name,
              m.priority, m.enabled, m.description,
              m.created_at, m.updated_at
       FROM model_combo_mappings m
       LEFT JOIN combos c ON c.id = m.combo_id
       WHERE m.id = ?`
    )
    .get(id) as MappingRow | undefined;
  return row ? rowToMapping(row) : null;
}

/**
 * Create a new model-combo mapping.
 */
export async function createModelComboMapping(data: {
  pattern: string;
  comboId: string;
  priority?: number;
  enabled?: boolean;
  description?: string;
}): Promise<ModelComboMapping> {
  const now = new Date().toISOString();
  const id = uuidv4();
  const priority = data.priority ?? 0;
  const enabled = data.enabled !== false ? 1 : 0;
  const description = data.description || "";

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("model_combo_mappings")
      .values({
        id,
        pattern: data.pattern,
        combo_id: data.comboId,
        priority,
        enabled,
        description,
        created_at: now,
        updated_at: now,
      })
      .execute();
  } else {
    const db = getDbInstance();
    db.prepare(
      `INSERT INTO model_combo_mappings
       (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, data.pattern, data.comboId, priority, enabled, description, now, now);
  }

  return {
    id,
    pattern: data.pattern,
    comboId: data.comboId,
    priority,
    enabled: data.enabled !== false,
    description,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update an existing model-combo mapping.
 */
export async function updateModelComboMapping(
  id: string,
  data: Partial<{
    pattern: string;
    comboId: string;
    priority: number;
    enabled: boolean;
    description: string;
  }>
): Promise<ModelComboMapping | null> {
  const existing = await getModelComboMappingById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updated = {
    pattern: data.pattern ?? existing.pattern,
    combo_id: data.comboId ?? existing.comboId,
    priority: data.priority ?? existing.priority,
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
    description: data.description ?? existing.description,
  };

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("model_combo_mappings")
      .set({
        pattern: updated.pattern,
        combo_id: updated.combo_id,
        priority: updated.priority,
        enabled: updated.enabled,
        description: updated.description,
        updated_at: now,
      })
      .where("id", "=", id)
      .execute();
    return getModelComboMappingById(id);
  }

  const db = getDbInstance();
  db.prepare(
    `UPDATE model_combo_mappings
     SET pattern = ?, combo_id = ?, priority = ?, enabled = ?,
         description = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    updated.pattern,
    updated.combo_id,
    updated.priority,
    updated.enabled,
    updated.description,
    now,
    id
  );

  return getModelComboMappingById(id);
}

/**
 * Delete a model-combo mapping.
 */
export async function deleteModelComboMapping(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("model_combo_mappings")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance();
  const result = db.prepare("DELETE FROM model_combo_mappings WHERE id = ?").run(id);
  return (result.changes ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────
// Core: Resolve combo for a model string
// ─────────────────────────────────────────────────────────────

/**
 * Check if a model string matches any enabled model-combo mapping.
 * Returns the full combo object if a match is found, null otherwise.
 *
 * Mappings are checked in priority order (highest first).
 * Uses glob-style pattern matching (* = any chars, ? = single char).
 */
export async function resolveComboForModel(
  modelStr: string
): Promise<Record<string, unknown> | null> {
  let rows: Array<{ pattern: string; combo_id: string; combo_data: string }>;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const pgRows = await getKyselyDb()
      .selectFrom("model_combo_mappings as m")
      .innerJoin("combos as c", "c.id", "m.combo_id")
      .select(["m.pattern", "m.combo_id", "c.data as combo_data"])
      .where("m.enabled", "=", 1)
      .orderBy("m.priority", "desc")
      .orderBy("m.created_at", "asc")
      .execute();
    rows = pgRows;
  } else {
    const db = getDbInstance();
    rows = db
      .prepare(
        `SELECT m.pattern, m.combo_id, c.data AS combo_data
         FROM model_combo_mappings m
         JOIN combos c ON c.id = m.combo_id
         WHERE m.enabled = 1
         ORDER BY m.priority DESC, m.created_at ASC`
      )
      .all() as Array<{ pattern: string; combo_id: string; combo_data: string }>;
  }

  for (const row of rows) {
    const regex = globToRegex(row.pattern);
    if (regex.test(modelStr)) {
      try {
        const combo = JSON.parse(row.combo_data) as Record<string, unknown>;
        if (combo.isActive === false) {
          continue;
        }
        return combo;
      } catch {
        // Corrupted combo data — skip
        continue;
      }
    }
  }

  return null;
}
