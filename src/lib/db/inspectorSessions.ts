/**
 * Database module: InspectorSessions
 * CRUD + snapshot for inspector_sessions and inspector_session_requests tables.
 */

import { randomUUID } from "crypto";
import { getDbInstance } from "./core";
import type { InspectorSessionRow } from "./_rowTypes";
import { InterceptedRequestSchema } from "../../mitm/inspector/types";
import type { InterceptedRequest } from "../../mitm/inspector/types";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

interface InspectorSessionDbRow {
  id: string;
  name: string | null;
  started_at: string;
  ended_at: string | null;
  request_count: number;
  profile: string | null;
}

interface InspectorSessionRequestDbRow {
  session_id: string;
  seq: number;
  payload: string;
}

function mapSessionRow(row: InspectorSessionDbRow): InspectorSessionRow {
  return {
    id: row.id,
    name: row.name,
    started_at: row.started_at,
    ended_at: row.ended_at,
    request_count: Number(row.request_count),
    profile: row.profile as "llm" | "custom" | "all" | null,
  };
}

export async function createSession(opts?: {
  name?: string;
  profile?: "llm" | "custom" | "all";
}): Promise<{ id: string; started_at: string }> {
  const id = randomUUID();
  const started_at = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("inspector_sessions")
      .values({
        id,
        name: opts?.name ?? null,
        started_at,
        profile: opts?.profile ?? null,
      })
      .execute();
    return { id, started_at };
  }

  const db = getDbInstance();
  db.prepare(
    `INSERT INTO inspector_sessions (id, name, started_at, profile) VALUES (?, ?, ?, ?)`
  ).run(id, opts?.name ?? null, started_at, opts?.profile ?? null);

  return { id, started_at };
}

export async function stopSession(id: string): Promise<void> {
  const ended_at = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("inspector_sessions")
      .set({ ended_at })
      .where("id", "=", id)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("UPDATE inspector_sessions SET ended_at = ? WHERE id = ?").run(ended_at, id);
}

export async function renameSession(id: string, name: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("inspector_sessions")
      .set({ name })
      .where("id", "=", id)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("UPDATE inspector_sessions SET name = ? WHERE id = ?").run(name, id);
}

export async function listSessions(): Promise<InspectorSessionRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("inspector_sessions")
      .selectAll()
      .orderBy("started_at", "desc")
      .execute();
    return rows.map((r) => mapSessionRow(r as InspectorSessionDbRow));
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM inspector_sessions ORDER BY started_at DESC")
    .all() as InspectorSessionDbRow[];
  return rows.map(mapSessionRow);
}

export async function getSession(id: string): Promise<InspectorSessionRow | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("inspector_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapSessionRow(row as InspectorSessionDbRow) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM inspector_sessions WHERE id = ?").get(id) as
    InspectorSessionDbRow | undefined;
  return row ? mapSessionRow(row) : null;
}

export async function appendSessionRequest(sessionId: string, payload: string): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    return getKyselyDb()
      .transaction()
      .execute(async (trx) => {
        const seqRow = await trx
          .selectFrom("inspector_session_requests")
          .select((eb) => eb.fn.coalesce(eb.fn.max("seq"), eb.lit(0)).as("max_seq"))
          .where("session_id", "=", sessionId)
          .executeTakeFirst();
        const nextSeq = Number(seqRow?.max_seq ?? 0) + 1;

        await trx
          .insertInto("inspector_session_requests")
          .values({ session_id: sessionId, seq: nextSeq, payload })
          .execute();

        await trx
          .updateTable("inspector_sessions")
          .set((eb) => ({ request_count: eb("request_count", "+", 1) }))
          .where("id", "=", sessionId)
          .execute();

        return nextSeq;
      });
  }

  const db = getDbInstance();
  let insertedSeq = 0;

  const runTransaction = db.transaction(() => {
    // Get next seq atomically within transaction
    const seqRow = db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM inspector_session_requests WHERE session_id = ?"
      )
      .get(sessionId) as { next_seq: number };

    const nextSeq = seqRow.next_seq;

    db.prepare(
      `INSERT INTO inspector_session_requests (session_id, seq, payload) VALUES (?, ?, ?)`
    ).run(sessionId, nextSeq, payload);

    db.prepare("UPDATE inspector_sessions SET request_count = request_count + 1 WHERE id = ?").run(
      sessionId
    );

    insertedSeq = nextSeq;
  });

  runTransaction();
  return insertedSeq;
}

export async function getSessionRequests(
  sessionId: string
): Promise<Array<{ seq: number; payload: string }>> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("inspector_session_requests")
      .select(["seq", "payload"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc")
      .execute();
    return rows.map((r) => ({ seq: Number(r.seq), payload: r.payload }));
  }

  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT seq, payload FROM inspector_session_requests WHERE session_id = ? ORDER BY seq ASC"
    )
    .all(sessionId) as InspectorSessionRequestDbRow[];
  return rows.map((r) => ({ seq: r.seq, payload: r.payload }));
}

export async function deleteSession(id: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    // No FK ON DELETE CASCADE in the Postgres greenfield schema (app-level
    // enforcement, matching every other table in bootstrap.sql) — cascade
    // manually within a transaction.
    await getKyselyDb()
      .transaction()
      .execute(async (trx) => {
        await trx.deleteFrom("inspector_session_requests").where("session_id", "=", id).execute();
        await trx.deleteFrom("inspector_sessions").where("id", "=", id).execute();
      });
    return;
  }

  const db = getDbInstance();
  // Cascade via FK ON DELETE CASCADE for inspector_session_requests
  db.prepare("DELETE FROM inspector_sessions WHERE id = ?").run(id);
}

/**
 * Return a parsed + validated snapshot of all requests for the given session,
 * sorted by ascending seq.
 *
 * Returns null when the session does not exist.
 * Rows whose payload fails InterceptedRequestSchema validation are silently
 * skipped (defensive — protects callers from corrupt/partial rows).
 *
 * Satisfies master-plan §3.8 (F2 spec) named-export contract.
 */
export async function snapshotSession(sessionId: string): Promise<InterceptedRequest[] | null> {
  // 1. Verify session exists.
  const session = await getSession(sessionId);
  if (session === null) return null;

  // 2. Retrieve raw rows (already ordered by seq ASC).
  const rawRows = await getSessionRequests(sessionId);

  // 3. Parse each payload JSON, validate via Zod schema, skip bad rows.
  const results: InterceptedRequest[] = [];
  for (const row of rawRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      // Corrupt JSON — skip.
      continue;
    }
    const result = InterceptedRequestSchema.safeParse(parsed);
    if (result.success) {
      results.push(result.data as InterceptedRequest);
    }
    // Invalid rows are silently skipped per defensive contract.
  }

  return results;
}
