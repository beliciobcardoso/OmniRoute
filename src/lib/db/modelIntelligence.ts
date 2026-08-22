/**
 * modelIntelligence.ts — DB domain module for model task-fitness scores.
 *
 * Persists per-model intelligence from arena ELO, models.dev tier rankings,
 * and user overrides. Resolution chain: user_override → arena_elo → models_dev_tier.
 *
 * @see Migration 097_model_intelligence.sql
 *
 * Read path (getModelIntelligence/getModelIntelligenceBySource/
 * getResolvedTaskFitness) stays SQLite-only/synchronous: it backs the
 * in-memory lookup cache in open-sse/services/autoCombo/taskFitness.ts,
 * called synchronously during Auto-Combo's per-request 12-factor scoring —
 * the same hot-path-must-stay-sync constraint documented for
 * quotaSnapshots.ts/proxies.ts/contextHandoffs.ts elsewhere in this effort.
 * Only the write/admin paths (background sync jobs, user-override CRUD) are
 * converted to async dual-dialect here.
 */

import { getDbInstance, rowToCamel } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// ──────────────── Types ────────────────

export interface ModelIntelligenceEntry {
  model: string;
  source: string;
  category: string;
  score: number;
  eloRaw: number | null;
  confidence: string | null;
  syncedAt: string;
  expiresAt: string | null;
  votes?: number;
  rank?: number;
}

// ──────────────── Helpers ────────────────

function rowToEntry(row: Record<string, unknown>): ModelIntelligenceEntry {
  const camel = rowToCamel(row) ?? {};
  return {
    model: String(camel.model ?? ""),
    source: String(camel.source ?? ""),
    category: String(camel.category ?? ""),
    score: typeof camel.score === "number" ? camel.score : 0,
    eloRaw: typeof camel.eloRaw === "number" ? camel.eloRaw : null,
    confidence: typeof camel.confidence === "string" ? camel.confidence : null,
    syncedAt: String(camel.syncedAt ?? ""),
    expiresAt: typeof camel.expiresAt === "string" ? camel.expiresAt : null,
  };
}

// ──────────────── CRUD ────────────────

/**
 * Hot-path read used by taskFitness.ts's in-memory cache. Stays SQLite-only —
 * see module docstring.
 */
export function getModelIntelligence(
  model: string,
  category: string
): ModelIntelligenceEntry | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT * FROM model_intelligence
       WHERE model = ? AND category = ?
         AND source IN ('user_override', 'arena_elo', 'models_dev_tier')
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
       ORDER BY CASE source
         WHEN 'user_override' THEN 1
         WHEN 'arena_elo' THEN 2
         WHEN 'models_dev_tier' THEN 3
       END
       LIMIT 1`
    )
    .get(model, category) as Record<string, unknown> | undefined;

  return row ? rowToEntry(row) : null;
}

/**
 * Hot-path read used by taskFitness.ts's in-memory cache. Stays SQLite-only —
 * see module docstring.
 */
export function getModelIntelligenceBySource(
  model: string,
  source: string,
  category: string
): ModelIntelligenceEntry | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT * FROM model_intelligence
       WHERE model = ? AND source = ? AND category = ?
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`
    )
    .get(model, source, category) as Record<string, unknown> | undefined;

  return row ? rowToEntry(row) : null;
}

export async function upsertModelIntelligence(
  entry: Omit<ModelIntelligenceEntry, "syncedAt">
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("model_intelligence")
      .values({
        model: entry.model,
        source: entry.source,
        category: entry.category,
        score: entry.score,
        elo_raw: entry.eloRaw ?? null,
        confidence: entry.confidence ?? null,
        synced_at: new Date().toISOString(),
        expires_at: entry.expiresAt ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["model", "source", "category"]).doUpdateSet((eb) => ({
          score: eb.ref("excluded.score"),
          elo_raw: eb.ref("excluded.elo_raw"),
          confidence: eb.ref("excluded.confidence"),
          synced_at: eb.ref("excluded.synced_at"),
          expires_at: eb.ref("excluded.expires_at"),
        }))
      )
      .execute();
    return;
  }

  const db = getDbInstance();

  db.prepare(
    `INSERT OR REPLACE INTO model_intelligence
       (model, source, category, score, elo_raw, confidence, synced_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  ).run(
    entry.model,
    entry.source,
    entry.category,
    entry.score,
    entry.eloRaw ?? null,
    entry.confidence ?? null,
    entry.expiresAt ?? null
  );
}

export async function deleteModelIntelligence(
  model: string,
  source: string,
  category: string
): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("model_intelligence")
      .where("model", "=", model)
      .where("source", "=", source)
      .where("category", "=", category)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  const db = getDbInstance();
  const result = db
    .prepare(
      `DELETE FROM model_intelligence
       WHERE model = ? AND source = ? AND category = ?`
    )
    .run(model, source, category);
  return (result.changes ?? 0) > 0;
}

export async function deleteExpiredIntelligence(source?: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const nowIso = new Date().toISOString();
    let query = kdb
      .deleteFrom("model_intelligence")
      .where("expires_at", "is not", null)
      .where("expires_at", "<", nowIso);
    if (source) query = query.where("source", "=", source);
    const result = await query.executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  const db = getDbInstance();
  const conditions = ["expires_at IS NOT NULL", "datetime(expires_at) < datetime('now')"];
  const params: unknown[] = [];

  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }

  const where = conditions.join(" AND ");
  const result = db.prepare(`DELETE FROM model_intelligence WHERE ${where}`).run(...params);
  return result.changes ?? 0;
}

export async function deleteModelIntelligenceBySource(source: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("model_intelligence")
      .where("source", "=", source)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  const db = getDbInstance();
  const result = db.prepare(`DELETE FROM model_intelligence WHERE source = ?`).run(source);
  return result.changes ?? 0;
}

export async function listModelIntelligence(filters?: {
  source?: string;
  category?: string;
}): Promise<ModelIntelligenceEntry[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    let query = kdb.selectFrom("model_intelligence").selectAll();
    if (filters?.source) query = query.where("source", "=", filters.source);
    if (filters?.category) query = query.where("category", "=", filters.category);
    const rows = await query
      .orderBy("model", "asc")
      .orderBy("source", "asc")
      .orderBy("category", "asc")
      .execute();
    return rows.map((r) => rowToEntry(r as unknown as Record<string, unknown>));
  }

  const db = getDbInstance();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters?.category) {
    conditions.push("category = ?");
    params.push(filters.category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM model_intelligence ${where} ORDER BY model ASC, source ASC, category ASC`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export async function bulkUpsertModelIntelligence(
  entries: Array<Omit<ModelIntelligenceEntry, "syncedAt">>
): Promise<number> {
  if (entries.length === 0) return 0;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const now = new Date().toISOString();
    await kdb.transaction().execute(async (trx) => {
      for (const entry of entries) {
        await trx
          .insertInto("model_intelligence")
          .values({
            model: entry.model,
            source: entry.source,
            category: entry.category,
            score: entry.score,
            elo_raw: entry.eloRaw ?? null,
            confidence: entry.confidence ?? null,
            synced_at: now,
            expires_at: entry.expiresAt ?? null,
          })
          .onConflict((oc) =>
            oc.columns(["model", "source", "category"]).doUpdateSet((eb) => ({
              score: eb.ref("excluded.score"),
              elo_raw: eb.ref("excluded.elo_raw"),
              confidence: eb.ref("excluded.confidence"),
              synced_at: eb.ref("excluded.synced_at"),
              expires_at: eb.ref("excluded.expires_at"),
            }))
          )
          .execute();
      }
    });
    return entries.length;
  }

  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO model_intelligence
       (model, source, category, score, elo_raw, confidence, synced_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  );

  const upsertAll = db.transaction(() => {
    let count = 0;
    for (const entry of entries) {
      stmt.run(
        entry.model,
        entry.source,
        entry.category,
        entry.score,
        entry.eloRaw ?? null,
        entry.confidence ?? null,
        entry.expiresAt ?? null
      );
      count++;
    }
    return count;
  });

  return upsertAll();
}

/**
 * Hot-path read used by taskFitness.ts's in-memory cache. Stays SQLite-only —
 * see module docstring.
 */
export function getResolvedTaskFitness(model: string, category: string): number | null {
  const entry = getModelIntelligence(model, category);
  return entry ? entry.score : null;
}

/**
 * Write a user_override entry for a model × category combination.
 * Used by taskFitness.ts resolution chain as Layer 1 (highest priority).
 *
 * @param model - Model identifier
 * @param category - Task category
 * @param score - Fitness score [0..1]
 */
export async function setUserFitnessOverrideEntry(
  model: string,
  category: string,
  score: number
): Promise<void> {
  await upsertModelIntelligence({
    model: model.toLowerCase(),
    source: "user_override",
    category: category.toLowerCase(),
    score: Math.max(0, Math.min(1, score)),
    eloRaw: null,
    confidence: null,
    expiresAt: null,
  });
}

/**
 * Delete a user_override entry for a model × category combination.
 *
 * @param model - Model identifier
 * @param category - Task category
 * @returns true if an entry was deleted
 */
export async function deleteUserFitnessOverrideEntry(
  model: string,
  category: string
): Promise<boolean> {
  return deleteModelIntelligence(model.toLowerCase(), "user_override", category.toLowerCase());
}
