import { sql } from "kysely";
import { v4 as uuidv4 } from "uuid";
import type {
  CompressionEngineId,
  CompressionPipelineStep,
} from "@omniroute/open-sse/services/compression/types.ts";

import { backupDbFile } from "./backup";
import { getDbInstance, rowToCamel } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export interface CompressionCombo {
  id: string;
  name: string;
  description: string;
  pipeline: CompressionPipelineStep[];
  languagePacks: string[];
  outputMode: boolean;
  outputModeIntensity: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompressionComboAssignment {
  id: string;
  compressionComboId: string;
  routingComboId: string;
  createdAt: string;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_COMPRESSION_COMBO_ID = "default-caveman";
const DEFAULT_COMPRESSION_COMBO_NAME = "Standard Savings";
const DEFAULT_COMPRESSION_COMBO_DESCRIPTION = "Default RTK + Caveman compression pipeline";
const LEGACY_DEFAULT_COMPRESSION_COMBO_DESCRIPTION = "Default Caveman compression pipeline";

function defaultCompressionComboPipeline(): CompressionPipelineStep[] {
  return [
    { engine: "rtk", intensity: "standard" },
    { engine: "caveman", intensity: "full" },
  ];
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

// Keep in sync with stackedPipelineStepSchema + ENGINE_CATALOG (#6747).
const KNOWN_ENGINE_IDS = [
  "lite",
  "caveman",
  "aggressive",
  "ultra",
  "rtk",
  "headroom",
  "session-dedup",
  "ccr",
  "llmlingua",
  "relevance",
];

function normalizePipeline(value: unknown): CompressionPipelineStep[] {
  return parseJsonArray<CompressionPipelineStep>(value, []).filter((step) => {
    return step && typeof step === "object" && KNOWN_ENGINE_IDS.includes(String(step.engine));
  });
}

function normalizeLanguagePacks(value: unknown): string[] {
  const packs = parseJsonArray<string>(value, ["en"]).filter(
    (pack): pack is string => typeof pack === "string" && pack.trim().length > 0
  );
  return [...new Set(packs.length > 0 ? packs.map((pack) => pack.trim()) : ["en"])];
}

function isLegacySeededDefaultPipeline(pipeline: CompressionPipelineStep[]): boolean {
  if (pipeline.length !== 1) return false;
  const [step] = pipeline;
  return step.engine === "caveman" && (step.intensity === undefined || step.intensity === "full");
}

async function upgradeLegacySeededDefaultCompressionCombo(): Promise<void> {
  if (isPostgres()) {
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("compression_combos")
      .select(["name", "description", "pipeline"])
      .where("id", "=", DEFAULT_COMPRESSION_COMBO_ID)
      .executeTakeFirst();
    if (!row) return;

    const description = String(row.description ?? "");
    const isSeededMetadata =
      String(row.name ?? "") === DEFAULT_COMPRESSION_COMBO_NAME &&
      (description === LEGACY_DEFAULT_COMPRESSION_COMBO_DESCRIPTION ||
        description === DEFAULT_COMPRESSION_COMBO_DESCRIPTION);

    if (!isSeededMetadata || !isLegacySeededDefaultPipeline(normalizePipeline(row.pipeline)))
      return;

    await kdb
      .updateTable("compression_combos")
      .set({
        description: DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
        pipeline: JSON.stringify(defaultCompressionComboPipeline()),
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", DEFAULT_COMPRESSION_COMBO_ID)
      .execute();
    return;
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT name, description, pipeline FROM compression_combos WHERE id = ?")
    .get(DEFAULT_COMPRESSION_COMBO_ID) as
    { name?: string; description?: string; pipeline?: string } | undefined;

  if (!row) return;

  const description = String(row.description ?? "");
  const isSeededMetadata =
    String(row.name ?? "") === DEFAULT_COMPRESSION_COMBO_NAME &&
    (description === LEGACY_DEFAULT_COMPRESSION_COMBO_DESCRIPTION ||
      description === DEFAULT_COMPRESSION_COMBO_DESCRIPTION);

  if (!isSeededMetadata || !isLegacySeededDefaultPipeline(normalizePipeline(row.pipeline))) return;

  db.prepare(
    `
    UPDATE compression_combos
    SET description = ?, pipeline = ?, updated_at = ?
    WHERE id = ?
  `
  ).run(
    DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
    JSON.stringify(defaultCompressionComboPipeline()),
    new Date().toISOString(),
    DEFAULT_COMPRESSION_COMBO_ID
  );
}

async function ensureCompressionComboTables(): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("compression_combos")
      .values({
        id: DEFAULT_COMPRESSION_COMBO_ID,
        name: DEFAULT_COMPRESSION_COMBO_NAME,
        description: DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
        pipeline: JSON.stringify(defaultCompressionComboPipeline()),
        language_packs: JSON.stringify(["en"]),
        output_mode: 0,
        output_mode_intensity: "full",
        is_default: 1,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await upgradeLegacySeededDefaultCompressionCombo();
    return;
  }

  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS compression_combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      pipeline TEXT NOT NULL DEFAULT '[]',
      language_packs TEXT DEFAULT '["en"]',
      output_mode INTEGER DEFAULT 0,
      output_mode_intensity TEXT DEFAULT 'full',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS compression_combo_assignments (
      id TEXT PRIMARY KEY,
      compression_combo_id TEXT NOT NULL REFERENCES compression_combos(id) ON DELETE CASCADE,
      routing_combo_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(routing_combo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_compression_combos_default
      ON compression_combos(is_default);
    CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_combo
      ON compression_combo_assignments(compression_combo_id);
    CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_routing
      ON compression_combo_assignments(routing_combo_id);
  `);
  db.prepare(
    `
    INSERT OR IGNORE INTO compression_combos (
      id, name, description, pipeline, language_packs, output_mode, output_mode_intensity, is_default
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    DEFAULT_COMPRESSION_COMBO_ID,
    DEFAULT_COMPRESSION_COMBO_NAME,
    DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
    JSON.stringify(defaultCompressionComboPipeline()),
    JSON.stringify(["en"]),
    0,
    "full",
    1
  );
  await upgradeLegacySeededDefaultCompressionCombo();
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") return Number(value) !== 0;
  if (typeof value === "string") return value !== "0" && value !== "";
  return Boolean(value);
}

function rowToCompressionCombo(row: unknown): CompressionCombo | null {
  if (!row) return null;
  const camel = rowToCamel(row as Record<string, unknown>) as JsonRecord;
  return {
    id: String(camel.id),
    name: String(camel.name ?? ""),
    description: String(camel.description ?? ""),
    pipeline: normalizePipeline(camel.pipeline),
    languagePacks: normalizeLanguagePacks(camel.languagePacks),
    outputMode: isTruthyFlag(camel.outputMode),
    outputModeIntensity: String(camel.outputModeIntensity ?? "full"),
    isDefault: isTruthyFlag(camel.isDefault),
    createdAt: String(camel.createdAt ?? ""),
    updatedAt: String(camel.updatedAt ?? ""),
  };
}

function rowToAssignment(row: unknown): CompressionComboAssignment | null {
  if (!row) return null;
  const camel = rowToCamel(row as Record<string, unknown>) as JsonRecord;
  return {
    id: String(camel.id),
    compressionComboId: String(camel.compressionComboId),
    routingComboId: String(camel.routingComboId),
    createdAt: String(camel.createdAt ?? ""),
  };
}

function buildComboPayload(data: Partial<CompressionCombo>, existing?: CompressionCombo) {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? data.id ?? uuidv4(),
    name: data.name?.trim() || existing?.name || "Compression Combo",
    description: data.description ?? existing?.description ?? "",
    pipeline:
      data.pipeline && data.pipeline.length > 0
        ? data.pipeline
        : existing?.pipeline && existing.pipeline.length > 0
          ? existing.pipeline
          : defaultCompressionComboPipeline(),
    languagePacks:
      data.languagePacks && data.languagePacks.length > 0
        ? data.languagePacks
        : existing?.languagePacks && existing.languagePacks.length > 0
          ? existing.languagePacks
          : ["en"],
    outputMode: data.outputMode ?? existing?.outputMode ?? false,
    outputModeIntensity: data.outputModeIntensity ?? existing?.outputModeIntensity ?? "full",
    isDefault: data.isDefault ?? existing?.isDefault ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function listCompressionCombos(): Promise<CompressionCombo[]> {
  await ensureCompressionComboTables();
  if (isPostgres()) {
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("compression_combos")
      .selectAll()
      .orderBy(sql`is_default desc`)
      .orderBy(sql`lower(name) asc`)
      .execute();
    return rows
      .map(rowToCompressionCombo)
      .filter((combo): combo is CompressionCombo => combo !== null);
  }
  const db = getDbInstance();
  return db
    .prepare("SELECT * FROM compression_combos ORDER BY is_default DESC, name COLLATE NOCASE ASC")
    .all()
    .map(rowToCompressionCombo)
    .filter((combo): combo is CompressionCombo => combo !== null);
}

export async function getCompressionCombo(id: string): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  if (isPostgres()) {
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("compression_combos")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return rowToCompressionCombo(row);
  }
  const row = getDbInstance().prepare("SELECT * FROM compression_combos WHERE id = ?").get(id);
  return rowToCompressionCombo(row);
}

export async function getDefaultCompressionCombo(): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  if (isPostgres()) {
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("compression_combos")
      .selectAll()
      .where("is_default", "=", 1)
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return rowToCompressionCombo(row);
  }
  const row = getDbInstance()
    .prepare(
      "SELECT * FROM compression_combos WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1"
    )
    .get();
  return rowToCompressionCombo(row);
}

export async function createCompressionCombo(
  data: Partial<CompressionCombo>
): Promise<CompressionCombo> {
  await ensureCompressionComboTables();
  const combo = buildComboPayload(data);

  if (isPostgres()) {
    const kdb = getKyselyDb();
    await kdb.transaction().execute(async (trx) => {
      if (combo.isDefault) {
        await trx.updateTable("compression_combos").set({ is_default: 0 }).execute();
      }
      await trx
        .insertInto("compression_combos")
        .values({
          id: combo.id,
          name: combo.name,
          description: combo.description,
          pipeline: JSON.stringify(combo.pipeline),
          language_packs: JSON.stringify(combo.languagePacks),
          output_mode: combo.outputMode ? 1 : 0,
          output_mode_intensity: combo.outputModeIntensity,
          is_default: combo.isDefault ? 1 : 0,
          created_at: combo.createdAt,
          updated_at: combo.updatedAt,
        })
        .execute();
    });
    return (await getCompressionCombo(combo.id)) as CompressionCombo;
  }

  const db = getDbInstance();
  const tx = db.transaction(() => {
    if (combo.isDefault) db.prepare("UPDATE compression_combos SET is_default = 0").run();
    db.prepare(
      `
      INSERT INTO compression_combos (
        id, name, description, pipeline, language_packs, output_mode, output_mode_intensity,
        is_default, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      combo.id,
      combo.name,
      combo.description,
      JSON.stringify(combo.pipeline),
      JSON.stringify(combo.languagePacks),
      combo.outputMode ? 1 : 0,
      combo.outputModeIntensity,
      combo.isDefault ? 1 : 0,
      combo.createdAt,
      combo.updatedAt
    );
  });
  tx();
  backupDbFile("pre-write");
  return (await getCompressionCombo(combo.id)) as CompressionCombo;
}

export async function updateCompressionCombo(
  id: string,
  data: Partial<CompressionCombo>
): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  const existing = await getCompressionCombo(id);
  if (!existing) return null;
  const combo = buildComboPayload(data, existing);

  if (isPostgres()) {
    const kdb = getKyselyDb();
    await kdb.transaction().execute(async (trx) => {
      if (combo.isDefault) {
        await trx.updateTable("compression_combos").set({ is_default: 0 }).execute();
      }
      await trx
        .updateTable("compression_combos")
        .set({
          name: combo.name,
          description: combo.description,
          pipeline: JSON.stringify(combo.pipeline),
          language_packs: JSON.stringify(combo.languagePacks),
          output_mode: combo.outputMode ? 1 : 0,
          output_mode_intensity: combo.outputModeIntensity,
          is_default: combo.isDefault ? 1 : 0,
          updated_at: combo.updatedAt,
        })
        .where("id", "=", id)
        .execute();
    });
    return getCompressionCombo(id);
  }

  const db = getDbInstance();
  const tx = db.transaction(() => {
    if (combo.isDefault) db.prepare("UPDATE compression_combos SET is_default = 0").run();
    db.prepare(
      `
      UPDATE compression_combos
      SET name = ?, description = ?, pipeline = ?, language_packs = ?, output_mode = ?,
          output_mode_intensity = ?, is_default = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(
      combo.name,
      combo.description,
      JSON.stringify(combo.pipeline),
      JSON.stringify(combo.languagePacks),
      combo.outputMode ? 1 : 0,
      combo.outputModeIntensity,
      combo.isDefault ? 1 : 0,
      combo.updatedAt,
      id
    );
  });
  tx();
  backupDbFile("pre-write");
  return getCompressionCombo(id);
}

export async function deleteCompressionCombo(id: string): Promise<boolean> {
  await ensureCompressionComboTables();
  const existing = await getCompressionCombo(id);
  if (!existing || existing.isDefault) return false;

  if (isPostgres()) {
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("compression_combos")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const result = getDbInstance().prepare("DELETE FROM compression_combos WHERE id = ?").run(id);
  if (result.changes > 0) backupDbFile("pre-write");
  return result.changes > 0;
}

export async function setDefaultCompressionCombo(id: string): Promise<boolean> {
  await ensureCompressionComboTables();
  if (!(await getCompressionCombo(id))) return false;
  const now = new Date().toISOString();

  if (isPostgres()) {
    const kdb = getKyselyDb();
    await kdb.transaction().execute(async (trx) => {
      await trx.updateTable("compression_combos").set({ is_default: 0 }).execute();
      await trx
        .updateTable("compression_combos")
        .set({ is_default: 1, updated_at: now })
        .where("id", "=", id)
        .execute();
    });
    return true;
  }

  const db = getDbInstance();
  db.transaction(() => {
    db.prepare("UPDATE compression_combos SET is_default = 0").run();
    db.prepare("UPDATE compression_combos SET is_default = 1, updated_at = ? WHERE id = ?").run(
      now,
      id
    );
  })();
  backupDbFile("pre-write");
  return true;
}

export async function getAssignmentsForCompressionCombo(
  id: string
): Promise<CompressionComboAssignment[]> {
  await ensureCompressionComboTables();
  if (isPostgres()) {
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("compression_combo_assignments")
      .selectAll()
      .where("compression_combo_id", "=", id)
      .orderBy("routing_combo_id")
      .execute();
    return rows
      .map(rowToAssignment)
      .filter((assignment): assignment is CompressionComboAssignment => assignment !== null);
  }
  return getDbInstance()
    .prepare(
      "SELECT * FROM compression_combo_assignments WHERE compression_combo_id = ? ORDER BY routing_combo_id"
    )
    .all(id)
    .map(rowToAssignment)
    .filter((assignment): assignment is CompressionComboAssignment => assignment !== null);
}

export async function getCompressionComboForRoutingCombo(
  routingComboId: string
): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  if (isPostgres()) {
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("compression_combos as c")
      .innerJoin("compression_combo_assignments as a", "a.compression_combo_id", "c.id")
      .selectAll("c")
      .where("a.routing_combo_id", "=", routingComboId)
      .limit(1)
      .executeTakeFirst();
    return rowToCompressionCombo(row);
  }
  const row = getDbInstance()
    .prepare(
      `
      SELECT c.*
      FROM compression_combos c
      JOIN compression_combo_assignments a ON a.compression_combo_id = c.id
      WHERE a.routing_combo_id = ?
      LIMIT 1
    `
    )
    .get(routingComboId);
  return rowToCompressionCombo(row);
}

export async function assignRoutingCombo(
  compressionComboId: string,
  routingComboId: string
): Promise<boolean> {
  await ensureCompressionComboTables();
  if (!(await getCompressionCombo(compressionComboId)) || !routingComboId.trim()) return false;

  if (isPostgres()) {
    const kdb = getKyselyDb();
    await kdb
      .insertInto("compression_combo_assignments")
      .values({
        id: uuidv4(),
        compression_combo_id: compressionComboId,
        routing_combo_id: routingComboId.trim(),
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.column("routing_combo_id").doUpdateSet({
          compression_combo_id: (eb) => eb.ref("excluded.compression_combo_id"),
          created_at: (eb) => eb.ref("excluded.created_at"),
        })
      )
      .execute();
    return true;
  }

  getDbInstance()
    .prepare(
      `
      INSERT OR REPLACE INTO compression_combo_assignments (
        id, compression_combo_id, routing_combo_id, created_at
      )
      VALUES (?, ?, ?, ?)
    `
    )
    .run(uuidv4(), compressionComboId, routingComboId.trim(), new Date().toISOString());
  backupDbFile("pre-write");
  return true;
}

export async function unassignRoutingCombo(
  compressionComboId: string,
  routingComboId: string
): Promise<boolean> {
  await ensureCompressionComboTables();
  if (isPostgres()) {
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("compression_combo_assignments")
      .where("compression_combo_id", "=", compressionComboId)
      .where("routing_combo_id", "=", routingComboId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
  const result = getDbInstance()
    .prepare(
      "DELETE FROM compression_combo_assignments WHERE compression_combo_id = ? AND routing_combo_id = ?"
    )
    .run(compressionComboId, routingComboId);
  if (result.changes > 0) backupDbFile("pre-write");
  return result.changes > 0;
}

// Static stackPriority map — mirrors the values defined in each engine file.
// Using a static map avoids cross-workspace imports (open-sse → src/lib/db) that
// would introduce a circular dependency detected by check:cycles.
const ENGINE_STACK_PRIORITY: Record<string, number> = {
  "session-dedup": 3,
  ccr: 4,
  lite: 5,
  rtk: 10,
  headroom: 15,
  caveman: 20,
  aggressive: 30,
  llmlingua: 35,
  ultra: 40,
};

export async function setEngineInDefaultCombo(
  engineId: string,
  enabled: boolean,
  config?: Record<string, unknown>
): Promise<CompressionCombo | null> {
  if (!KNOWN_ENGINE_IDS.includes(engineId)) return null;
  await ensureCompressionComboTables();
  const existing = await getDefaultCompressionCombo();
  if (!existing) return null;

  let newPipeline = [...existing.pipeline];
  if (enabled) {
    const idx = newPipeline.findIndex((s) => s.engine === engineId);
    if (idx >= 0) {
      if (config !== undefined) {
        newPipeline[idx] = { ...newPipeline[idx], config };
      }
    } else {
      newPipeline.push({ engine: engineId as CompressionEngineId, ...(config ? { config } : {}) });
    }
    // Sort by stackPriority ascending so the pipeline runs in the correct order.
    newPipeline.sort((a, b) => {
      const pa = ENGINE_STACK_PRIORITY[a.engine] ?? 50;
      const pb = ENGINE_STACK_PRIORITY[b.engine] ?? 50;
      return pa - pb;
    });
  } else {
    newPipeline = newPipeline.filter((s) => s.engine !== engineId);
  }

  // Direct UPDATE — preserves empty pipeline (Fix #2) without going through
  // buildComboPayload which falls back to defaultCompressionComboPipeline() when
  // the incoming array is empty.
  const now = new Date().toISOString();

  if (isPostgres()) {
    const kdb = getKyselyDb();
    await kdb
      .updateTable("compression_combos")
      .set({ pipeline: JSON.stringify(newPipeline), updated_at: now })
      .where("id", "=", existing.id)
      .execute();
    return getCompressionCombo(existing.id);
  }

  const db = getDbInstance();
  db.prepare("UPDATE compression_combos SET pipeline = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(newPipeline),
    now,
    existing.id
  );
  backupDbFile("pre-write");

  return getCompressionCombo(existing.id);
}

export async function updateAssignments(
  compressionComboId: string,
  routingComboIds: string[]
): Promise<boolean> {
  await ensureCompressionComboTables();
  if (!(await getCompressionCombo(compressionComboId))) return false;
  const cleanedIds = [...new Set(routingComboIds.map((id) => id.trim()).filter(Boolean))];

  if (isPostgres()) {
    const kdb = getKyselyDb();
    await kdb.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("compression_combo_assignments")
        .where("compression_combo_id", "=", compressionComboId)
        .execute();
      for (const routingComboId of cleanedIds) {
        await trx
          .deleteFrom("compression_combo_assignments")
          .where("routing_combo_id", "=", routingComboId)
          .execute();
        await trx
          .insertInto("compression_combo_assignments")
          .values({
            id: uuidv4(),
            compression_combo_id: compressionComboId,
            routing_combo_id: routingComboId,
            created_at: new Date().toISOString(),
          })
          .execute();
      }
    });
    return true;
  }

  const db = getDbInstance();
  db.transaction(() => {
    db.prepare("DELETE FROM compression_combo_assignments WHERE compression_combo_id = ?").run(
      compressionComboId
    );
    if (cleanedIds.length > 0) {
      const deleteExisting = db.prepare(
        "DELETE FROM compression_combo_assignments WHERE routing_combo_id = ?"
      );
      const insert = db.prepare(
        `
        INSERT INTO compression_combo_assignments (
          id, compression_combo_id, routing_combo_id, created_at
        )
        VALUES (?, ?, ?, ?)
      `
      );
      for (const routingComboId of cleanedIds) {
        deleteExisting.run(routingComboId);
        insert.run(uuidv4(), compressionComboId, routingComboId, new Date().toISOString());
      }
    }
  })();
  backupDbFile("pre-write");
  return true;
}
