/**
 * Postgres implementation of the combo repository contract. Behavior mirrors
 * sqliteComboRepository.ts and is proven by the shared conformance suite
 * (tests/helpers/persistence/comboRepositoryConformance.ts).
 *
 * The small row helpers are duplicated from the SQLite repository on purpose:
 * that file is upstream-owned, and keeping it untouched keeps upstream syncs
 * conflict-free.
 *
 * Differences that are inherent to the backend:
 * - Writes that SQLite serializes in-process (next sort order, reorder) take a
 *   transaction-scoped advisory lock so concurrent replicas cannot interleave.
 * - Case-insensitive name matching uses lower(); SQLite COLLATE NOCASE folds
 *   ASCII only, so non-ASCII names can compare differently.
 * - State owned by a combo in still-SQLite domains (proxy assignments, LKGP,
 *   key grants) is cleaned after the Postgres commit, in its own SQLite
 *   transaction — not atomic across stores (partial backend, driverConfig.ts).
 */

import { sql, type Kysely, type Transaction } from "kysely";
import { v4 as uuidv4 } from "uuid";
import type {
  ComboReorderResult,
  ComboRepository,
  ComboUpdateResult,
} from "@/domain/persistence/comboRepositories";
import { normalizeComboRecord } from "@/lib/combos/steps";
import { validateComboInvariant } from "@/lib/combos/invariants";
import { revokeComboGrantsByName } from "../apiKeys/comboGrantRevocation";
import { getDbInstance } from "../core";
import { ensurePostgresBootstrap, getPostgresDb } from "../postgres/client";
import type { Database } from "../postgres/schema";
import { bumpProxyRegistryGeneration } from "../proxies/registryGeneration";
import {
  applyComboDeletionEffects,
  purgeComboOwnedState,
  type ComboImportBatchResult,
} from "./comboDependents";

type JsonRecord = Record<string, unknown>;
type Db = Kysely<Database> | Transaction<Database>;

/** Serializes sort-order allocation and reordering across replicas. */
const COMBO_ORDER_LOCK_KEY = 872234872;

const COMBO_COLUMNS = ["id", "name", "data", "sort_order", "context_cache_protection"] as const;

async function connect(): Promise<Kysely<Database>> {
  await ensurePostgresBootstrap();
  return getPostgresDb();
}

async function lockComboOrder(trx: Transaction<Database>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${COMBO_ORDER_LOCK_KEY})`.execute(trx);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function parseComboRow(row: unknown): JsonRecord | null {
  const record = asRecord(row);
  const payload = typeof record.data === "string" ? record.data : null;
  if (!payload) return null;
  const parsed = JSON.parse(payload) as JsonRecord;
  if (typeof record.sort_order === "number") parsed.sortOrder = record.sort_order;
  // The row id is authoritative over a stale id inside the JSON blob.
  if (typeof record.id === "string" && record.id.trim().length > 0) parsed.id = record.id;
  // The column only overrides when enabled; FALSE keeps the JSON blob value so
  // pre-migration rows are not silently disabled (same rule as SQLite's 1/0).
  if (record.context_cache_protection === true) parsed.context_cache_protection = true;
  return parsed;
}

async function getComboNameSet(db: Db, extraNames: string[] = []): Promise<Set<string>> {
  const rows = await db.selectFrom("combos").select("name").execute();
  const names = new Set<string>();
  for (const name of [...rows.map((row) => row.name), ...extraNames]) {
    if (typeof name === "string" && name.trim().length > 0) names.add(name.trim());
  }
  return names;
}

async function normalizeStoredCombo(
  db: Db,
  combo: JsonRecord,
  extraNames: string[] = []
): Promise<JsonRecord> {
  return normalizeComboRecord(combo, {
    allCombos: await getComboNameSet(db, extraNames),
  }) as JsonRecord;
}

async function getNextSortOrder(db: Db): Promise<number> {
  const row = await db
    .selectFrom("combos")
    .select(sql<number>`COALESCE(MAX(sort_order), 0)`.as("sort_order"))
    .executeTakeFirst();
  return Number(row?.sort_order ?? 0) + 1;
}

async function getCombos(limit?: number, offset?: number): Promise<JsonRecord[]> {
  const db = await connect();
  let query = db
    .selectFrom("combos")
    .select(COMBO_COLUMNS)
    .orderBy("sort_order", "asc")
    .orderBy(sql`lower(name)`, "asc");
  if (limit !== undefined) query = query.limit(limit).offset(offset ?? 0);

  const rawCombos = (await query.execute())
    .map((row) => parseComboRow(row))
    .filter((row): row is JsonRecord => row !== null);
  const comboNames = rawCombos
    .map((combo) => (typeof combo.name === "string" ? combo.name.trim() : ""))
    .filter((name) => name.length > 0);

  return rawCombos.map(
    (combo) => normalizeComboRecord(combo, { allCombos: comboNames }) as JsonRecord
  );
}

async function countCombos(): Promise<number> {
  const db = await connect();
  const row = await db
    .selectFrom("combos")
    .select(sql<number>`count(*)::int`.as("cnt"))
    .executeTakeFirst();
  return Number(row?.cnt ?? 0);
}

async function findOne(
  where: (db: Kysely<Database>) => Promise<unknown>,
  extraName: (combo: JsonRecord) => string[]
): Promise<JsonRecord | null> {
  const db = await connect();
  const combo = parseComboRow(await where(db));
  if (!combo) return null;
  return normalizeStoredCombo(db, combo, extraName(combo));
}

function getComboById(id: string): Promise<JsonRecord | null> {
  return findOne(
    (db) => db.selectFrom("combos").select(COMBO_COLUMNS).where("id", "=", id).executeTakeFirst(),
    (combo) => (typeof combo.name === "string" ? [combo.name] : [])
  );
}

function getComboByName(name: string): Promise<JsonRecord | null> {
  return findOne(
    (db) =>
      db.selectFrom("combos").select(COMBO_COLUMNS).where("name", "=", name).executeTakeFirst(),
    () => [name]
  );
}

// #4446: case-insensitive fallback lookup, see sqliteComboRepository.ts.
function getComboByNameInsensitive(name: string): Promise<JsonRecord | null> {
  return findOne(
    (db) =>
      db
        .selectFrom("combos")
        .select(COMBO_COLUMNS)
        .where(sql`lower(name)`, "=", name.toLowerCase())
        .limit(1)
        .executeTakeFirst(),
    (combo) => [typeof combo.name === "string" ? combo.name : name]
  );
}

async function insertComboRow(trx: Transaction<Database>, data: JsonRecord): Promise<JsonRecord> {
  const now = new Date().toISOString();
  const sortOrder =
    typeof data.sortOrder === "number" ? data.sortOrder : await getNextSortOrder(trx);
  const comboId = typeof data.id === "string" && data.id.trim().length > 0 ? data.id : uuidv4();
  const combo = await normalizeStoredCombo(
    trx,
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

  validateComboInvariant(combo);
  await trx
    .insertInto("combos")
    .values({
      id: String(combo.id),
      name: combo.name as string,
      data: JSON.stringify(combo),
      sort_order: sortOrder,
      created_at: now,
      updated_at: now,
      context_cache_protection: Boolean(data.context_cache_protection),
    })
    .execute();

  return combo;
}

async function createCombo(data: JsonRecord): Promise<JsonRecord> {
  const db = await connect();
  return db.transaction().execute(async (trx) => {
    await lockComboOrder(trx);
    return insertComboRow(trx, data);
  });
}

async function updateCombo(id: string, data: JsonRecord): Promise<ComboUpdateResult | null> {
  const db = await connect();
  return db.transaction().execute(async (trx) => {
    // Row lock: the JSON blob is read-modify-written, so concurrent updates
    // from other replicas must not interleave (SQLite gets this from its
    // single writer).
    const existing = await trx
      .selectFrom("combos")
      .select(COMBO_COLUMNS)
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) return null;
    const current = parseComboRow(existing);
    if (!current) return null;

    const sortOrder =
      typeof data.sortOrder === "number"
        ? data.sortOrder
        : typeof current.sortOrder === "number"
          ? current.sortOrder
          : await getNextSortOrder(trx);
    const merged: JsonRecord = {
      ...current,
      ...data,
      sortOrder,
      updatedAt: new Date().toISOString(),
    };
    // Remove fields explicitly set to null (for deletion support)
    for (const key of Object.keys(data)) {
      if (data[key] === null) delete merged[key];
    }
    const currentName = typeof current.name === "string" ? current.name : "";
    const nextName =
      typeof merged.name === "string" && merged.name.trim().length > 0 ? merged.name : currentName;
    const normalizedMerged = await normalizeStoredCombo(trx, { ...merged, name: nextName }, [
      nextName,
    ]);
    validateComboInvariant({
      ...normalizedMerged,
      ...data,
      name: nextName,
      models: normalizedMerged.models,
    });

    await trx
      .updateTable("combos")
      .set({
        name: nextName,
        data: JSON.stringify(normalizedMerged),
        sort_order: sortOrder,
        updated_at: String(normalizedMerged.updatedAt),
        context_cache_protection: Boolean(normalizedMerged.context_cache_protection),
      })
      .where("id", "=", id)
      .execute();

    return {
      combo: normalizedMerged,
      previousName: currentName,
      currentName: nextName,
      modelsFieldProvided: data.models !== undefined,
    };
  });
}

async function reorderCombos(comboIds: string[]): Promise<ComboReorderResult> {
  const db = await connect();
  const rowsReordered = await db.transaction().execute(async (trx) => {
    await lockComboOrder(trx);
    const rows = await trx
      .selectFrom("combos")
      .select(["id", "name", "data", "sort_order", "context_cache_protection"])
      .orderBy("sort_order", "asc")
      .orderBy(sql`lower(name)`, "asc")
      .execute();
    if (rows.length === 0) return 0;

    const existingIds = new Set(rows.map((row) => row.id));
    const seen = new Set<string>();
    const requestedIds = comboIds.filter((id) => {
      if (!existingIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const orderedIds = [
      ...requestedIds,
      ...rows.map((row) => row.id).filter((id) => !seen.has(id)),
    ];

    const rowById = new Map(rows.map((row) => [row.id, row]));
    const comboNames = rows
      .map((row) => {
        const combo = parseComboRow(row);
        return combo && typeof combo.name === "string" ? combo.name.trim() : "";
      })
      .filter((name) => name.length > 0);
    const now = new Date().toISOString();

    for (const [index, id] of orderedIds.entries()) {
      const row = rowById.get(id);
      const combo = row ? parseComboRow(row) : null;
      if (!combo) continue;
      const sortOrder = index + 1;
      const updatedCombo = normalizeComboRecord(
        { ...combo, sortOrder, updatedAt: now },
        { allCombos: comboNames }
      );
      await trx
        .updateTable("combos")
        .set({ data: JSON.stringify(updatedCombo), sort_order: sortOrder, updated_at: now })
        .where("id", "=", id)
        .execute();
    }
    return orderedIds.length;
  });

  return { combos: rowsReordered > 0 ? await getCombos() : [], rowsReordered };
}

async function isComboNameInUse(db: Db, name: string): Promise<boolean> {
  const row = await db
    .selectFrom("combos")
    .select("id")
    .where(sql`lower(name)`, "=", name.trim().toLowerCase())
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

async function deleteCombo(id: string): Promise<boolean> {
  const db = await connect();
  const deleted = await db.transaction().execute(async (trx) => {
    const row = await trx
      .deleteFrom("combos")
      .where("id", "=", id)
      .returning("name")
      .executeTakeFirst();
    if (!row) return null;
    return { name: row.name, nameStillInUse: await isComboNameInUse(trx, row.name) };
  });
  if (!deleted) return false;

  const sqlite = getDbInstance();
  const cleanup = sqlite.transaction(() => {
    const owned = purgeComboOwnedState(sqlite, id, deleted.name);
    // Grants are stored by name: revoke them with the row, or a combo recreated
    // under the same name would inherit every key's old grant.
    const revokedKeys = revokeComboGrantsByName(sqlite, deleted.name, {
      nameStillInUse: deleted.nameStillInUse,
    }).length;
    return { ...owned, revokedKeys };
  });
  await applyComboDeletionEffects(cleanup());
  return true;
}

/**
 * Same contract as sqliteComboRepository.importComboBatch: all combo inserts
 * and (with `replaceVisible`) deletions of user-visible combos commit or roll
 * back together; hidden system-managed combos are never removed.
 */
export async function importPostgresComboBatch(
  entries: JsonRecord[],
  options: { replaceVisible: boolean }
): Promise<ComboImportBatchResult> {
  const db = await connect();
  const { created, removed } = await db.transaction().execute(async (trx) => {
    await lockComboOrder(trx);
    const removedCombos: Array<{ id: string; name: string }> = [];
    if (options.replaceVisible) {
      const rows = await trx.selectFrom("combos").select(["id", "data"]).execute();
      for (const row of rows) {
        const combo = parseComboRow(row);
        if (!combo || combo.isHidden === true || typeof combo.id !== "string") continue;
        const gone = await trx
          .deleteFrom("combos")
          .where("id", "=", combo.id)
          .returning("name")
          .executeTakeFirst();
        if (gone) removedCombos.push({ id: combo.id, name: gone.name });
      }
    }
    const createdCombos: JsonRecord[] = [];
    for (const entry of entries) createdCombos.push(await insertComboRow(trx, entry));
    return { created: createdCombos, removed: removedCombos };
  });

  // Revoke key grants only for names the file did not bring back.
  const namesInUse = new Set([...(await getComboNameSet(db))].map((name) => name.toLowerCase()));
  const sqlite = getDbInstance();
  const cleanup = sqlite.transaction(() => {
    let purged = 0;
    let revokedKeys = 0;
    const lkgpKeys: string[] = [];
    for (const combo of removed) {
      const owned = purgeComboOwnedState(sqlite, combo.id, combo.name);
      purged += owned.purged;
      lkgpKeys.push(...owned.lkgpKeys);
    }
    for (const combo of removed) {
      revokedKeys += revokeComboGrantsByName(sqlite, combo.name, {
        nameStillInUse: namesInUse.has(combo.name.trim().toLowerCase()),
      }).length;
    }
    return { purged, revokedKeys, lkgpKeys };
  })();
  if (cleanup.purged > 0) bumpProxyRegistryGeneration();

  return {
    created,
    removed: removed.length,
    lkgpKeys: cleanup.lkgpKeys,
    revokedKeys: cleanup.revokedKeys,
  };
}

export const postgresComboRepository: ComboRepository = {
  list: getCombos,
  count: countCombos,
  findById: getComboById,
  findByName: getComboByName,
  findByNameInsensitive: getComboByNameInsensitive,
  create: createCombo,
  update: updateCombo,
  reorder: reorderCombos,
  deleteById: deleteCombo,
};
