/**
 * db/playgroundPresets.ts — Playground Studio preset persistence.
 *
 * CRUD operations for the playground_presets table (migration 076).
 * All queries use db.prepare() (better-sqlite3) — never raw db.exec() or
 * string interpolation.
 *
 * @module lib/db/playgroundPresets
 */

import { getDbInstance } from "./core";
import { randomUUID } from "node:crypto";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

// TODO(F1-merge): swap to import from "@/shared/schemas/playground" after F1 lands
export interface PlaygroundPresetListItem {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  system: string | null;
  params: Record<string, unknown>;
  created_at: string;
}

type PlaygroundPresetRow = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  system: string | null;
  params_json: string;
  created_at: string;
};

function rowToItem(row: PlaygroundPresetRow): PlaygroundPresetListItem {
  let params: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.params_json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    }
  } catch {
    params = {};
  }
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    model: row.model,
    system: row.system,
    params,
    created_at: row.created_at,
  };
}

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

/**
 * Returns all presets ordered by created_at descending (newest first).
 */
export async function listPlaygroundPresets(): Promise<PlaygroundPresetListItem[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("playground_presets")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(rowToItem);
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM playground_presets ORDER BY created_at DESC")
    .all() as PlaygroundPresetRow[];
  return rows.map(rowToItem);
}

/**
 * Returns a single preset by id, or null when not found.
 */
export async function getPlaygroundPreset(id: string): Promise<PlaygroundPresetListItem | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("playground_presets")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToItem(row) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM playground_presets WHERE id = ? LIMIT 1").get(id) as
    PlaygroundPresetRow | undefined;
  if (!row) return null;
  return rowToItem(row);
}

/**
 * Creates a new preset. Generates a UUID v4 for the id.
 * Returns the persisted row via getPlaygroundPreset.
 */
export async function createPlaygroundPreset(input: {
  name: string;
  endpoint: string;
  model: string;
  system: string | null | undefined;
  params: Record<string, unknown>;
}): Promise<PlaygroundPresetListItem> {
  const id = randomUUID();
  const params_json = JSON.stringify(input.params ?? {});
  const system = input.system ?? null;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("playground_presets")
      .values({
        id,
        name: input.name,
        endpoint: input.endpoint,
        model: input.model,
        system,
        params_json,
      })
      .execute();
  } else {
    const db = getDbInstance();
    db.prepare(
      "INSERT INTO playground_presets (id, name, endpoint, model, system, params_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, input.name, input.endpoint, input.model, system, params_json);
  }

  const created = await getPlaygroundPreset(id);
  // created cannot be null here — we just inserted the row
  return created as PlaygroundPresetListItem;
}

/**
 * Updates only the supplied fields on an existing preset.
 * Returns the updated row, or null when the id does not exist.
 */
export async function updatePlaygroundPreset(
  id: string,
  patch: Partial<{
    name: string;
    endpoint: string;
    model: string;
    system: string | null;
    params: Record<string, unknown>;
  }>
): Promise<PlaygroundPresetListItem | null> {
  // Verify row exists before building the dynamic UPDATE
  const existing = await getPlaygroundPreset(id);
  if (!existing) return null;

  const updateValues: Record<string, unknown> = {};
  if (patch.name !== undefined) updateValues.name = patch.name;
  if (patch.endpoint !== undefined) updateValues.endpoint = patch.endpoint;
  if (patch.model !== undefined) updateValues.model = patch.model;
  if ("system" in patch) updateValues.system = patch.system ?? null;
  if (patch.params !== undefined) updateValues.params_json = JSON.stringify(patch.params);

  if (Object.keys(updateValues).length === 0) {
    // Empty patch — return current row unchanged
    return existing;
  }

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("playground_presets")
      .set(updateValues)
      .where("id", "=", id)
      .execute();
    return getPlaygroundPreset(id);
  }

  const db = getDbInstance();
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(updateValues)) {
    setClauses.push(`${column} = ?`);
    values.push(value);
  }
  values.push(id);
  db.prepare(`UPDATE playground_presets SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

  return getPlaygroundPreset(id);
}

/**
 * Deletes a preset by id.
 * Returns true when a row was deleted, false when the id did not exist.
 */
export async function deletePlaygroundPreset(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("playground_presets")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance();
  const result = db.prepare("DELETE FROM playground_presets WHERE id = ?").run(id);
  return result.changes > 0;
}
