/**
 * db/semanticCache.ts — CRUD queries over the `semantic_cache` table.
 * Extracted from the /api/cache/entries route handler.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/cache/entries route can delegate.
 *
 * Sliced out of #3500 (semantic_cache cluster, slice 4).
 */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// Postgres BIGINT columns (hit_count, tokens_saved) come back as JS strings
// from node-postgres, not numbers — coerce before returning to callers.
function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SemanticCacheEntry {
  id: string;
  signature: string;
  model: string;
  hit_count: number;
  tokens_saved: number;
  created_at: string;
  expires_at: string;
}

export interface SemanticCacheListOptions {
  page: number;
  limit: number;
  search: string;
  model: string;
  sortBy: string;
  sortOrder: string;
}

export interface SemanticCacheListResult {
  entries: SemanticCacheEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const VALID_SORT_COLUMNS = [
  "created_at",
  "expires_at",
  "hit_count",
  "tokens_saved",
  "model",
] as const;

function normalizeEntry(row: {
  id: string;
  signature: string;
  model: string;
  hit_count: number | string | null;
  tokens_saved: number | string | null;
  created_at: string;
  expires_at: string;
}): SemanticCacheEntry {
  return {
    id: row.id,
    signature: row.signature,
    model: row.model,
    hit_count: toInt(row.hit_count),
    tokens_saved: toInt(row.tokens_saved),
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/**
 * Returns a paginated, filtered, sorted list of semantic cache entries.
 * All dynamic inputs (sortBy/sortOrder) are validated before use.
 */
export async function listSemanticCacheEntries(
  opts: SemanticCacheListOptions
): Promise<SemanticCacheListResult> {
  const { page, limit, search, model, sortBy, sortOrder } = opts;
  const offset = (page - 1) * limit;
  const orderBy = (VALID_SORT_COLUMNS as readonly string[]).includes(sortBy)
    ? (sortBy as (typeof VALID_SORT_COLUMNS)[number])
    : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    let countQuery = kdb.selectFrom("semantic_cache").select((eb) => eb.fn.countAll().as("total"));
    let listQuery = kdb
      .selectFrom("semantic_cache")
      .select([
        "id",
        "signature",
        "model",
        "hit_count",
        "tokens_saved",
        "created_at",
        "expires_at",
      ]);

    if (search) {
      countQuery = countQuery.where((eb) =>
        eb.or([eb("signature", "like", `%${search}%`), eb("model", "like", `%${search}%`)])
      );
      listQuery = listQuery.where((eb) =>
        eb.or([eb("signature", "like", `%${search}%`), eb("model", "like", `%${search}%`)])
      );
    }
    if (model) {
      countQuery = countQuery.where("model", "=", model);
      listQuery = listQuery.where("model", "=", model);
    }

    const countRow = await countQuery.executeTakeFirst();
    const rows = await listQuery.orderBy(orderBy, order).limit(limit).offset(offset).execute();

    return { entries: rows.map(normalizeEntry), total: countRow ? toInt(countRow.total) : 0 };
  }

  const db = getDbInstance();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push("(signature LIKE ? OR model LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  if (model) {
    conditions.push("model = ?");
    params.push(model);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM semantic_cache ${whereClause}`)
    .get(...params) as { total: number };

  const entries = db
    .prepare(
      `SELECT id, signature, model, hit_count, tokens_saved, created_at, expires_at
       FROM semantic_cache ${whereClause}
       ORDER BY ${orderBy} ${order.toUpperCase()}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as SemanticCacheEntry[];

  return { entries: entries.map(normalizeEntry), total: countRow?.total || 0 };
}

export interface DeleteSemanticCacheBySignatureResult {
  deleted: number;
}

/**
 * Deletes the single semantic cache entry matching the given signature.
 * Returns `{ deleted: 1 }` on success.
 */
export async function deleteSemanticCacheBySignature(
  signature: string
): Promise<DeleteSemanticCacheBySignatureResult> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb().deleteFrom("semantic_cache").where("signature", "=", signature).execute();
    return { deleted: 1 };
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM semantic_cache WHERE signature = ?").run(signature);
  return { deleted: 1 };
}

export interface DeleteSemanticCacheByModelResult {
  deleted: number;
}

/**
 * Deletes all semantic cache entries for the given model.
 * Returns `{ deleted: N }` where N is the number of rows removed.
 */
export async function deleteSemanticCacheByModel(
  model: string
): Promise<DeleteSemanticCacheByModelResult> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("semantic_cache")
      .where("model", "=", model)
      .executeTakeFirst();
    return { deleted: Number(result.numDeletedRows) };
  }

  const db = getDbInstance();
  const result = db.prepare("DELETE FROM semantic_cache WHERE model = ?").run(model);
  return { deleted: result.changes };
}
