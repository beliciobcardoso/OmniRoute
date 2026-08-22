import { getDbInstance, rowToCamel } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export interface HandoffPayload {
  id?: string;
  sessionId: string;
  comboName: string;
  fromAccount: string;
  summary: string;
  keyDecisions: string[];
  taskProgress: string;
  activeEntities: string[];
  messageCount: number;
  model: string;
  lastModel?: string;
  warningThresholdPct: number;
  generatedAt: string;
  expiresAt: string;
  createdAt?: string;
}

type JsonRecord = Record<string, unknown>;

interface StatementLike<TRow = unknown> {
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

const CLEANUP_THROTTLE_MS = 30 * 60 * 1000;

let lastCleanupAt = 0;

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : String(item))).filter(Boolean);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => (typeof item === "string" ? item : String(item))).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function toHandoffPayload(row: unknown): HandoffPayload | null {
  const camel = rowToCamel(row) as JsonRecord | null;
  if (!camel) return null;

  return {
    id: typeof camel.id === "string" ? camel.id : undefined,
    sessionId: typeof camel.sessionId === "string" ? camel.sessionId : "",
    comboName: typeof camel.comboName === "string" ? camel.comboName : "",
    fromAccount: typeof camel.fromAccount === "string" ? camel.fromAccount : "",
    summary: typeof camel.summary === "string" ? camel.summary : "",
    keyDecisions: parseJsonArray(camel.keyDecisions),
    taskProgress: typeof camel.taskProgress === "string" ? camel.taskProgress : "",
    activeEntities: parseJsonArray(camel.activeEntities),
    messageCount: Number.isFinite(Number(camel.messageCount)) ? Number(camel.messageCount) : 0,
    model: typeof camel.model === "string" ? camel.model : "",
    lastModel: typeof camel.lastModel === "string" ? camel.lastModel : undefined,
    warningThresholdPct: Number.isFinite(Number(camel.warningThresholdPct))
      ? Number(camel.warningThresholdPct)
      : 0.85,
    generatedAt: typeof camel.generatedAt === "string" ? camel.generatedAt : "",
    expiresAt: typeof camel.expiresAt === "string" ? camel.expiresAt : "",
    createdAt: typeof camel.createdAt === "string" ? camel.createdAt : undefined,
  };
}

export async function upsertHandoff(payload: HandoffPayload): Promise<void> {
  const createdAt = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("context_handoffs")
      .values({
        session_id: payload.sessionId,
        combo_name: payload.comboName,
        from_account: payload.fromAccount,
        summary: payload.summary,
        key_decisions: JSON.stringify(payload.keyDecisions),
        task_progress: payload.taskProgress,
        active_entities: JSON.stringify(payload.activeEntities),
        message_count: payload.messageCount,
        model: payload.model,
        last_model: payload.lastModel ?? null,
        warning_threshold_pct: payload.warningThresholdPct,
        generated_at: payload.generatedAt,
        expires_at: payload.expiresAt,
        created_at: createdAt,
      })
      .onConflict((oc) =>
        oc.columns(["session_id", "combo_name"]).doUpdateSet((eb) => ({
          from_account: eb.ref("excluded.from_account"),
          summary: eb.ref("excluded.summary"),
          key_decisions: eb.ref("excluded.key_decisions"),
          task_progress: eb.ref("excluded.task_progress"),
          active_entities: eb.ref("excluded.active_entities"),
          message_count: eb.ref("excluded.message_count"),
          model: eb.ref("excluded.model"),
          last_model: eb.ref("excluded.last_model"),
          warning_threshold_pct: eb.ref("excluded.warning_threshold_pct"),
          generated_at: eb.ref("excluded.generated_at"),
          expires_at: eb.ref("excluded.expires_at"),
        }))
      )
      .execute();
    return;
  }

  const db = getDbInstance() as unknown as DbLike;

  db.prepare(
    `INSERT INTO context_handoffs
      (session_id, combo_name, from_account, summary, key_decisions,
       task_progress, active_entities, message_count, model, last_model,
       warning_threshold_pct, generated_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, combo_name) DO UPDATE SET
       from_account = excluded.from_account,
       summary = excluded.summary,
       key_decisions = excluded.key_decisions,
       task_progress = excluded.task_progress,
       active_entities = excluded.active_entities,
       message_count = excluded.message_count,
       model = excluded.model,
       last_model = excluded.last_model,
       warning_threshold_pct = excluded.warning_threshold_pct,
       generated_at = excluded.generated_at,
       expires_at = excluded.expires_at`
  ).run(
    payload.sessionId,
    payload.comboName,
    payload.fromAccount,
    payload.summary,
    JSON.stringify(payload.keyDecisions),
    payload.taskProgress,
    JSON.stringify(payload.activeEntities),
    payload.messageCount,
    payload.model,
    payload.lastModel ?? null,
    payload.warningThresholdPct,
    payload.generatedAt,
    payload.expiresAt,
    createdAt
  );
}

export async function getHandoff(
  sessionId: string,
  comboName: string
): Promise<HandoffPayload | null> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("context_handoffs")
      .selectAll()
      .where("session_id", "=", sessionId)
      .where("combo_name", "=", comboName)
      .where("expires_at", ">", now)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return toHandoffPayload(row);
  }

  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare(
      `SELECT *
       FROM context_handoffs
       WHERE session_id = ? AND combo_name = ? AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(sessionId, comboName, now);

  return toHandoffPayload(row);
}

export async function deleteHandoff(sessionId: string, comboName: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .deleteFrom("context_handoffs")
      .where("session_id", "=", sessionId)
      .where("combo_name", "=", comboName)
      .execute();
    return;
  }

  const db = getDbInstance() as unknown as DbLike;
  db.prepare("DELETE FROM context_handoffs WHERE session_id = ? AND combo_name = ?").run(
    sessionId,
    comboName
  );
}

export async function cleanupExpiredHandoffs(): Promise<number> {
  const nowMs = Date.now();
  if (nowMs - lastCleanupAt < CLEANUP_THROTTLE_MS) {
    return 0;
  }
  const now = new Date(nowMs).toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("context_handoffs")
      .where("expires_at", "<=", now)
      .executeTakeFirst();
    lastCleanupAt = nowMs;
    return Number(result.numDeletedRows ?? 0);
  }

  const db = getDbInstance() as unknown as DbLike;
  const result = db.prepare("DELETE FROM context_handoffs WHERE expires_at <= ?").run(now);
  lastCleanupAt = nowMs;
  return result.changes;
}

export async function hasActiveHandoff(sessionId: string, comboName: string): Promise<boolean> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("context_handoffs")
      .select("id")
      .where("session_id", "=", sessionId)
      .where("combo_name", "=", comboName)
      .where("expires_at", ">", now)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare(
      `SELECT 1
       FROM context_handoffs
       WHERE session_id = ? AND combo_name = ? AND expires_at > ?
       LIMIT 1`
    )
    .get(sessionId, comboName, now);

  return !!row;
}

/**
 * Record a model usage entry for a session/combo combination.
 * Used by context-relay to track which models have been active.
 *
 * @param sessionId - The session identifier.
 * @param comboName - The combo name.
 * @param modelStr - The model string (e.g. "claude-sonnet-4-20250514").
 * @param provider - The provider identifier.
 * @param connectionId - Optional connection ID used.
 */
export async function recordSessionModelUsage(
  sessionId: string,
  comboName: string,
  modelStr: string,
  provider: string,
  connectionId?: string
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("session_model_history")
      .values({
        session_id: sessionId,
        combo_name: comboName,
        model_str: modelStr,
        provider,
        connection_id: connectionId || null,
      })
      .execute();
    return;
  }

  const db = getDbInstance() as unknown as DbLike;
  db.prepare(
    `INSERT INTO session_model_history
      (session_id, combo_name, model_str, provider, connection_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, comboName, modelStr, provider, connectionId || null);
}

/**
 * Get the most recently used model for a session/combo combination.
 * Returns null if no usage has been recorded.
 *
 * @param sessionId - The session identifier.
 * @param comboName - The combo name.
 * @returns The model string, or null if no record exists.
 */
export async function getLastSessionModel(
  sessionId: string,
  comboName: string
): Promise<string | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("session_model_history")
      .select("model_str")
      .where("session_id", "=", sessionId)
      .where("combo_name", "=", comboName)
      .orderBy("used_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.model_str ?? null;
  }

  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare(
      `SELECT model_str
       FROM session_model_history
       WHERE session_id = ? AND combo_name = ?
       ORDER BY used_at DESC, id DESC
       LIMIT 1`
    )
    .get(sessionId, comboName) as { model_str: string } | undefined;

  return row?.model_str ?? null;
}

/**
 * Clear all session model history entries for a given combo name.
 * Called when a combo's model targets are changed to invalidate stale context-cache pins.
 *
 * @param comboName - The combo name whose pins should be cleared.
 * @returns The number of deleted entries.
 */
export async function clearSessionModelHistoryForCombo(comboName: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb
      .deleteFrom("session_model_history")
      .where("combo_name", "=", comboName)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  const db = getDbInstance() as unknown as DbLike;
  const result = db
    .prepare("DELETE FROM session_model_history WHERE combo_name = ?")
    .run(comboName);
  return result.changes ?? 0;
}
