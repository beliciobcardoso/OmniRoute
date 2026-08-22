/**
 * db/combos.js — Combo CRUD operations.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance } from "./core";
import { backupDbFile } from "./backup";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";
import type { SqliteBoolean } from "./kysely/types";
import { invalidateDbCache } from "./readCache";
import { normalizeComboRecord } from "@/lib/combos/steps";
import { clearSessionModelHistoryForCombo } from "./contextHandoffs";

type JsonRecord = Record<string, unknown>;

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function getSerializedData(value: unknown): string | null {
  const row = asRecord(value);
  return typeof row.data === "string" ? row.data : null;
}

// Postgres declares sort_order as BIGINT, which node-postgres returns as a
// JS string — coerce before any numeric use.
function getSortOrder(value: unknown): number | null {
  const row = asRecord(value);
  if (typeof row.sort_order === "number") return row.sort_order;
  if (typeof row.sort_order === "string" && row.sort_order.trim().length > 0) {
    const parsed = Number(row.sort_order);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Postgres declares context_cache_protection as native BOOLEAN (true/false),
// while SQLite stores it as INTEGER 0/1 — normalize both before use.
function isContextCacheProtectionSet(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function withSortOrder(payload: string, sortOrder: number | null): JsonRecord {
  const parsed = JSON.parse(payload) as JsonRecord;
  if (typeof sortOrder === "number") {
    parsed.sortOrder = sortOrder;
  }
  return parsed;
}

async function getComboNameSet(extraNames: string[] = []): Promise<Set<string>> {
  let rows: unknown[];

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    rows = await getKyselyDb().selectFrom("combos").select("name").execute();
  } else {
    rows = getDbInstance().prepare("SELECT name FROM combos").all();
  }

  const names = new Set<string>();

  for (const row of rows) {
    const record = asRecord(row);
    if (typeof record.name === "string" && record.name.trim().length > 0) {
      names.add(record.name.trim());
    }
  }

  for (const name of extraNames) {
    if (typeof name === "string" && name.trim().length > 0) {
      names.add(name.trim());
    }
  }

  return names;
}

async function normalizeStoredCombo(
  combo: JsonRecord,
  extraNames: string[] = []
): Promise<JsonRecord> {
  return normalizeComboRecord(combo, {
    allCombos: await getComboNameSet(extraNames),
  }) as JsonRecord;
}

function parseComboRow(row: unknown): JsonRecord | null {
  const payload = getSerializedData(row);
  if (!payload) return null;
  const parsed = withSortOrder(payload, getSortOrder(row));
  // Merge deduplicated column values back into the record
  const record = asRecord(row);
  if (record.context_cache_protection !== undefined && record.context_cache_protection !== null) {
    // Column is authoritative when explicitly enabled.
    // When column is falsy (unset default) preserve the JSON blob value
    // to avoid silently disabling the feature on pre-migration rows.
    if (isContextCacheProtectionSet(record.context_cache_protection)) {
      parsed.context_cache_protection = true;
    }
    // Column is unset — keep existing JSON blob value
  }
  return parsed;
}

async function getNextSortOrder(): Promise<number> {
  let row: unknown;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    row = await getKyselyDb()
      .selectFrom("combos")
      .select((eb) => eb.fn.coalesce(eb.fn.max("sort_order"), eb.lit(0)).as("sort_order"))
      .executeTakeFirst();
  } else {
    row = getDbInstance()
      .prepare("SELECT COALESCE(MAX(sort_order), 0) AS sort_order FROM combos")
      .get();
  }

  const sortOrder = getSortOrder(row);
  return (sortOrder ?? 0) + 1;
}

export async function getCombos() {
  let rows: unknown[];

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    rows = await getKyselyDb()
      .selectFrom("combos")
      .select(["data", "sort_order", "context_cache_protection"])
      .orderBy("sort_order", "asc")
      .orderBy(({ fn }) => fn("lower", ["name"]), "asc")
      .execute();
  } else {
    rows = getDbInstance()
      .prepare(
        "SELECT data, sort_order, context_cache_protection FROM combos ORDER BY sort_order ASC, name COLLATE NOCASE ASC"
      )
      .all();
  }

  const rawCombos = rows
    .map((row) => parseComboRow(row))
    .filter((row): row is JsonRecord => row !== null);

  const comboNames = rawCombos
    .map((combo) => (typeof combo.name === "string" ? combo.name.trim() : ""))
    .filter((name): name is string => name.length > 0);

  return rawCombos.map((combo) =>
    normalizeComboRecord(combo, {
      allCombos: comboNames,
    })
  );
}

export async function getComboById(id: string) {
  let row: unknown;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    row = await getKyselyDb()
      .selectFrom("combos")
      .select(["data", "sort_order", "context_cache_protection"])
      .where("id", "=", id)
      .executeTakeFirst();
  } else {
    row = getDbInstance()
      .prepare("SELECT data, sort_order, context_cache_protection FROM combos WHERE id = ?")
      .get(id);
  }

  const combo = parseComboRow(row);
  if (!combo) return null;
  return normalizeStoredCombo(combo, typeof combo.name === "string" ? [combo.name] : []);
}

export async function getComboByName(name: string) {
  let row: unknown;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    row = await getKyselyDb()
      .selectFrom("combos")
      .select(["data", "sort_order", "context_cache_protection"])
      .where("name", "=", name)
      .executeTakeFirst();
  } else {
    row = getDbInstance()
      .prepare("SELECT data, sort_order, context_cache_protection FROM combos WHERE name = ?")
      .get(name);
  }

  const combo = parseComboRow(row);
  if (!combo) return null;
  return normalizeStoredCombo(combo, [name]);
}

// #4446: case-insensitive name lookup. The opencode dispatch path forwards a
// lowercased combo slug (e.g. "master-light") for a combo provisioned as
// "MASTER-LIGHT"; the default BINARY collation of getComboByName misses it.
// Used only as a fallback after the exact match fails, so it cannot change the
// resolution of any combo that already resolves today.
export async function getComboByNameInsensitive(name: string) {
  let row: unknown;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    row = await getKyselyDb()
      .selectFrom("combos")
      .select(["data", "sort_order", "context_cache_protection"])
      .where(({ fn, eb }) => eb(fn("lower", ["name"]), "=", name.toLowerCase()))
      .executeTakeFirst();
  } else {
    row = getDbInstance()
      .prepare(
        "SELECT data, sort_order, context_cache_protection FROM combos WHERE name = ? COLLATE NOCASE"
      )
      .get(name);
  }

  const combo = parseComboRow(row);
  if (!combo) return null;
  const storedName = typeof combo.name === "string" ? combo.name : name;
  return normalizeStoredCombo(combo, [storedName]);
}

export async function createCombo(data: JsonRecord) {
  const now = new Date().toISOString();
  const sortOrder = typeof data.sortOrder === "number" ? data.sortOrder : await getNextSortOrder();
  const comboId = typeof data.id === "string" && data.id.trim().length > 0 ? data.id : uuidv4();
  const combo = await normalizeStoredCombo(
    {
      ...data,
      id: comboId,
      name: data.name,
      models: data.models || [],
      strategy: data.strategy || "priority",
      config: data.config || {},
      isHidden: Boolean(data.isHidden),
      sortOrder,
      createdAt: now,
      updatedAt: now,
    },
    typeof data.name === "string" ? [data.name] : []
  );

  const comboName = typeof combo.name === "string" ? combo.name : "";
  const dataJson = JSON.stringify(combo);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("combos")
      .values({
        id: combo.id as string,
        name: comboName,
        data: dataJson,
        sort_order: sortOrder,
        created_at: now,
        updated_at: now,
        context_cache_protection: Boolean(
          data.context_cache_protection
        ) as unknown as SqliteBoolean,
      })
      .execute();
  } else {
    const contextCache = data.context_cache_protection ? 1 : 0;
    getDbInstance()
      .prepare(
        "INSERT INTO combos (id, name, data, sort_order, created_at, updated_at, context_cache_protection) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(combo.id, comboName, dataJson, sortOrder, now, now, contextCache);
  }

  invalidateDbCache("combos");
  if (!isPostgres()) backupDbFile("pre-write");
  return combo;
}

export async function updateCombo(id: string, data: JsonRecord) {
  let existing: unknown;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    existing = await getKyselyDb()
      .selectFrom("combos")
      .select(["data", "sort_order", "context_cache_protection"])
      .where("id", "=", id)
      .executeTakeFirst();
  } else {
    existing = getDbInstance()
      .prepare("SELECT data, sort_order, context_cache_protection FROM combos WHERE id = ?")
      .get(id);
  }
  if (!existing) return null;

  const current = parseComboRow(existing);
  if (!current) return null;
  const sortOrder =
    typeof data.sortOrder === "number"
      ? data.sortOrder
      : typeof current.sortOrder === "number"
        ? current.sortOrder
        : await getNextSortOrder();
  const merged: JsonRecord = {
    ...current,
    ...data,
    sortOrder,
    updatedAt: new Date().toISOString(),
  };
  // Remove fields explicitly set to null (for deletion support)
  for (const key of Object.keys(data)) {
    if (data[key] === null) {
      delete merged[key];
    }
  }
  const currentName = typeof current.name === "string" ? current.name : "";
  const nextName =
    typeof merged["name"] === "string" && merged["name"].trim().length > 0
      ? merged["name"]
      : currentName;
  const normalizedMerged = await normalizeStoredCombo({ ...merged, name: nextName }, [nextName]);
  const contextCacheProtectionSet = Boolean(normalizedMerged.context_cache_protection);

  if (isPostgres()) {
    await getKyselyDb()
      .updateTable("combos")
      .set({
        name: nextName,
        data: JSON.stringify(normalizedMerged),
        sort_order: sortOrder,
        updated_at: normalizedMerged.updatedAt as string,
        context_cache_protection: contextCacheProtectionSet as unknown as SqliteBoolean,
      })
      .where("id", "=", id)
      .execute();
  } else {
    getDbInstance()
      .prepare(
        "UPDATE combos SET name = ?, data = ?, sort_order = ?, updated_at = ?, context_cache_protection = ? WHERE id = ?"
      )
      .run(
        nextName,
        JSON.stringify(normalizedMerged),
        sortOrder,
        normalizedMerged.updatedAt,
        contextCacheProtectionSet ? 1 : 0,
        id
      );
  }

  // Invalidate stale context-cache pins when combo targets change.
  // Without this, sessions pinned to removed models keep routing there forever.
  if (data.models !== undefined) {
    const cleared = clearSessionModelHistoryForCombo(currentName);
    if (cleared > 0) {
      // Also clear under the new name if the combo was renamed
      if (nextName !== currentName) {
        clearSessionModelHistoryForCombo(nextName);
      }
    }
  }

  invalidateDbCache("combos");
  if (!isPostgres()) backupDbFile("pre-write");
  return normalizedMerged;
}

export async function reorderCombos(comboIds: string[]) {
  const pg = isPostgres();
  let rows: unknown[];

  if (pg) {
    await ensurePostgresBootstrap();
    rows = await getKyselyDb()
      .selectFrom("combos")
      .select(["id", "name", "data", "sort_order"])
      .orderBy("sort_order", "asc")
      .orderBy(({ fn }) => fn("lower", ["name"]), "asc")
      .execute();
  } else {
    rows = getDbInstance()
      .prepare(
        "SELECT id, name, data, sort_order FROM combos ORDER BY sort_order ASC, name COLLATE NOCASE ASC"
      )
      .all();
  }
  if (rows.length === 0) return [];

  const existingIds = new Set(
    rows
      .map((row) => {
        const record = asRecord(row);
        return typeof record.id === "string" ? record.id : null;
      })
      .filter((id): id is string => id !== null)
  );

  const seen = new Set<string>();
  const requestedIds = comboIds.filter((id) => {
    if (!existingIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const orderedIds = [
    ...requestedIds,
    ...rows
      .map((row) => {
        const record = asRecord(row);
        return typeof record.id === "string" ? record.id : null;
      })
      .filter((id): id is string => id !== null && !seen.has(id)),
  ];

  const now = new Date().toISOString();
  const rowById = new Map(
    rows.map((row) => {
      const record = asRecord(row);
      return [String(record.id), row];
    })
  );
  const comboNames = rows
    .map((row) => {
      const combo = parseComboRow(row);
      return combo && typeof combo.name === "string" ? combo.name.trim() : "";
    })
    .filter((name): name is string => name.length > 0);

  const updates: Array<{ id: string; data: string; sortOrder: number }> = [];
  orderedIds.forEach((id, index) => {
    const row = rowById.get(id);
    const combo = row ? parseComboRow(row) : null;
    if (!combo) return;
    const sortOrder = index + 1;
    const updatedCombo = normalizeComboRecord(
      { ...combo, sortOrder, updatedAt: now },
      { allCombos: comboNames }
    );
    updates.push({ id, data: JSON.stringify(updatedCombo), sortOrder });
  });

  if (pg) {
    const kdb = getKyselyDb();
    await kdb.transaction().execute(async (trx) => {
      for (const u of updates) {
        await trx
          .updateTable("combos")
          .set({ data: u.data, sort_order: u.sortOrder, updated_at: now })
          .where("id", "=", u.id)
          .execute();
      }
    });
  } else {
    const db = getDbInstance();
    const update = db.prepare(
      "UPDATE combos SET data = ?, sort_order = ?, updated_at = ? WHERE id = ?"
    );
    const reorderTransaction = db.transaction(() => {
      for (const u of updates) {
        update.run(u.data, u.sortOrder, now, u.id);
      }
    });
    reorderTransaction();
  }

  invalidateDbCache("combos");
  if (!pg) backupDbFile("pre-write");
  return getCombos();
}

export async function deleteCombo(id: string) {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb().deleteFrom("combos").where("id", "=", id).executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) return false;
    invalidateDbCache("combos");
    return true;
  }

  const result = getDbInstance().prepare("DELETE FROM combos WHERE id = ?").run(id);
  if (result.changes === 0) return false;
  invalidateDbCache("combos");
  backupDbFile("pre-write");
  return true;
}

export async function deleteComboByName(name: string) {
  const combo = await getComboByName(name);
  if (!combo || typeof combo.id !== "string") return false;
  return deleteCombo(combo.id);
}

export async function setActiveCombo(name: string): Promise<void> {
  const value = JSON.stringify(name);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: "settings", key: "activeCombo", value })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value }))
      .execute();
    return;
  }

  getDbInstance()
    .prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'activeCombo', ?)"
    )
    .run(value);
}
