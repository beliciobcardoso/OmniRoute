/**
 * Postgres implementation of model → combo mapping persistence and
 * resolution. Mirrors sqliteModelComboMappingRepository.ts; proven by the
 * shared conformance suite. Mappings are removed with their combo by the
 * ON DELETE CASCADE foreign key, same as SQLite.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  CreateModelComboMappingInput,
  ModelComboMapping,
  ModelComboMappingRepository,
  UpdateModelComboMappingInput,
} from "@/domain/persistence/comboRepositories";
import { globToRegex } from "@/shared/utils/globPattern";
import { ensurePostgresBootstrap, getPostgresDb } from "../postgres/client";

async function connect() {
  await ensurePostgresBootstrap();
  return getPostgresDb();
}

interface MappingRow {
  id: string;
  pattern: string;
  combo_id: string;
  combo_name: string | null;
  priority: number | null;
  enabled: boolean | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMapping(row: MappingRow): ModelComboMapping {
  return {
    id: row.id,
    pattern: row.pattern,
    comboId: row.combo_id,
    comboName: row.combo_name || undefined,
    priority: row.priority as number,
    enabled: row.enabled === true,
    description: row.description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function selectMappings() {
  const db = await connect();
  return db
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
    ]);
}

async function getModelComboMappings(options?: {
  limit?: number;
  offset?: number;
}): Promise<{ items: ModelComboMapping[]; total: number }> {
  let query = (await selectMappings()).orderBy("m.priority", "desc").orderBy("m.created_at", "asc");
  if (options?.limit !== undefined) query = query.limit(options.limit).offset(options.offset ?? 0);
  const rows = (await query.execute()) as MappingRow[];

  const db = await connect();
  const totalRow = await db
    .selectFrom("model_combo_mappings")
    .select((eb) => eb.fn.countAll<number>().as("cnt"))
    .executeTakeFirst();
  return { items: rows.map(rowToMapping), total: Number(totalRow?.cnt ?? 0) };
}

async function getModelComboMappingById(id: string): Promise<ModelComboMapping | null> {
  const row = (await (await selectMappings()).where("m.id", "=", id).executeTakeFirst()) as
    MappingRow | undefined;
  return row ? rowToMapping(row) : null;
}

async function createModelComboMapping(
  data: CreateModelComboMappingInput
): Promise<ModelComboMapping> {
  const db = await connect();
  const now = new Date().toISOString();
  const id = uuidv4();
  await db
    .insertInto("model_combo_mappings")
    .values({
      id,
      pattern: data.pattern,
      combo_id: data.comboId,
      priority: data.priority ?? 0,
      enabled: data.enabled !== false,
      description: data.description || "",
      created_at: now,
      updated_at: now,
    })
    .execute();

  return {
    id,
    pattern: data.pattern,
    comboId: data.comboId,
    priority: data.priority ?? 0,
    enabled: data.enabled !== false,
    description: data.description || "",
    createdAt: now,
    updatedAt: now,
  };
}

async function updateModelComboMapping(
  id: string,
  data: UpdateModelComboMappingInput
): Promise<ModelComboMapping | null> {
  const existing = await getModelComboMappingById(id);
  if (!existing) return null;

  const db = await connect();
  await db
    .updateTable("model_combo_mappings")
    .set({
      pattern: data.pattern ?? existing.pattern,
      combo_id: data.comboId ?? existing.comboId,
      priority: data.priority ?? existing.priority,
      enabled: data.enabled !== undefined ? data.enabled : existing.enabled,
      description: data.description ?? existing.description,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .execute();

  return getModelComboMappingById(id);
}

async function deleteModelComboMapping(id: string): Promise<boolean> {
  const db = await connect();
  const result = await db
    .deleteFrom("model_combo_mappings")
    .where("id", "=", id)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/**
 * First enabled mapping (highest priority first) whose glob pattern matches
 * the model string and whose combo is active and parseable.
 */
async function resolveComboForModel(modelStr: string): Promise<Record<string, unknown> | null> {
  const db = await connect();
  const rows = await db
    .selectFrom("model_combo_mappings as m")
    .innerJoin("combos as c", "c.id", "m.combo_id")
    .select(["m.pattern", "m.combo_id", "c.data as combo_data"])
    .where("m.enabled", "=", true)
    .orderBy("m.priority", "desc")
    .orderBy("m.created_at", "asc")
    .execute();

  for (const row of rows) {
    if (!globToRegex(row.pattern).test(modelStr)) continue;
    try {
      const combo = JSON.parse(row.combo_data) as Record<string, unknown>;
      if (combo.isActive === false) continue;
      return combo;
    } catch {
      // Corrupted combo data — skip
      continue;
    }
  }
  return null;
}

export const postgresModelComboMappingRepository: ModelComboMappingRepository = {
  list: getModelComboMappings,
  findById: getModelComboMappingById,
  create: createModelComboMapping,
  update: updateModelComboMapping,
  deleteById: deleteModelComboMapping,
  resolveForModel: resolveComboForModel,
};
