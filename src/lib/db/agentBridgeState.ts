/**
 * Database module: AgentBridgeState
 * CRUD operations for agent_bridge_state table.
 */

import { getDbInstance } from "./core.ts";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";
import type { AgentBridgeStateRow } from "./_rowTypes.ts";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

// SQLite stores booleans as 0/1 integers
interface AgentBridgeStateDbRow {
  agent_id: string;
  dns_enabled: number;
  cert_trusted: number;
  setup_completed: number;
  last_started_at: string | null;
  last_error: string | null;
}

function mapRow(row: AgentBridgeStateDbRow): AgentBridgeStateRow {
  return {
    agent_id: row.agent_id,
    dns_enabled: toBool(row.dns_enabled),
    cert_trusted: toBool(row.cert_trusted),
    setup_completed: toBool(row.setup_completed),
    last_started_at: row.last_started_at,
    last_error: row.last_error,
  };
}

export async function getAllAgentBridgeStates(): Promise<AgentBridgeStateRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("agent_bridge_state")
      .selectAll()
      .orderBy("agent_id", "asc")
      .execute();
    return rows.map((r) =>
      mapRow({
        agent_id: r.agent_id,
        dns_enabled: toBool(r.dns_enabled) ? 1 : 0,
        cert_trusted: toBool(r.cert_trusted) ? 1 : 0,
        setup_completed: toBool(r.setup_completed) ? 1 : 0,
        last_started_at: r.last_started_at,
        last_error: r.last_error,
      })
    );
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM agent_bridge_state ORDER BY agent_id ASC")
    .all() as AgentBridgeStateDbRow[];
  return rows.map(mapRow);
}

export async function getAgentBridgeState(agentId: string): Promise<AgentBridgeStateRow | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const r = await kdb
      .selectFrom("agent_bridge_state")
      .selectAll()
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    if (!r) return null;
    return mapRow({
      agent_id: r.agent_id,
      dns_enabled: toBool(r.dns_enabled) ? 1 : 0,
      cert_trusted: toBool(r.cert_trusted) ? 1 : 0,
      setup_completed: toBool(r.setup_completed) ? 1 : 0,
      last_started_at: r.last_started_at,
      last_error: r.last_error,
    });
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM agent_bridge_state WHERE agent_id = ?").get(agentId) as
    AgentBridgeStateDbRow | undefined;
  return row ? mapRow(row) : null;
}

export async function upsertAgentBridgeState(
  row: Partial<AgentBridgeStateRow> & { agent_id: string }
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const existing = await getAgentBridgeState(row.agent_id);

    if (!existing) {
      await kdb
        .insertInto("agent_bridge_state")
        .values({
          agent_id: row.agent_id,
          dns_enabled: row.dns_enabled ? 1 : 0,
          cert_trusted: row.cert_trusted ? 1 : 0,
          setup_completed: row.setup_completed ? 1 : 0,
          last_started_at: row.last_started_at ?? null,
          last_error: row.last_error ?? null,
        })
        .execute();
      return;
    }

    const updates: Record<string, unknown> = {};
    if (row.dns_enabled !== undefined) updates.dns_enabled = row.dns_enabled ? 1 : 0;
    if (row.cert_trusted !== undefined) updates.cert_trusted = row.cert_trusted ? 1 : 0;
    if (row.setup_completed !== undefined) updates.setup_completed = row.setup_completed ? 1 : 0;
    if (row.last_started_at !== undefined) updates.last_started_at = row.last_started_at;
    if (row.last_error !== undefined) updates.last_error = row.last_error;

    if (Object.keys(updates).length === 0) return;

    await kdb
      .updateTable("agent_bridge_state")
      .set(updates)
      .where("agent_id", "=", row.agent_id)
      .execute();
    return;
  }

  const db = getDbInstance();
  const existing = db
    .prepare("SELECT * FROM agent_bridge_state WHERE agent_id = ?")
    .get(row.agent_id) as AgentBridgeStateDbRow | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO agent_bridge_state
         (agent_id, dns_enabled, cert_trusted, setup_completed, last_started_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      row.agent_id,
      row.dns_enabled !== undefined ? (row.dns_enabled ? 1 : 0) : 0,
      row.cert_trusted !== undefined ? (row.cert_trusted ? 1 : 0) : 0,
      row.setup_completed !== undefined ? (row.setup_completed ? 1 : 0) : 0,
      row.last_started_at ?? null,
      row.last_error ?? null
    );
  } else {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (row.dns_enabled !== undefined) {
      fields.push("dns_enabled = ?");
      values.push(row.dns_enabled ? 1 : 0);
    }
    if (row.cert_trusted !== undefined) {
      fields.push("cert_trusted = ?");
      values.push(row.cert_trusted ? 1 : 0);
    }
    if (row.setup_completed !== undefined) {
      fields.push("setup_completed = ?");
      values.push(row.setup_completed ? 1 : 0);
    }
    if (row.last_started_at !== undefined) {
      fields.push("last_started_at = ?");
      values.push(row.last_started_at);
    }
    if (row.last_error !== undefined) {
      fields.push("last_error = ?");
      values.push(row.last_error);
    }

    if (fields.length === 0) return;

    values.push(row.agent_id);
    db.prepare(`UPDATE agent_bridge_state SET ${fields.join(", ")} WHERE agent_id = ?`).run(
      ...values
    );
  }
}

export async function setLastStarted(agentId: string, ts: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("agent_bridge_state")
      .values({ agent_id: agentId, last_started_at: ts })
      .onConflict((oc) => oc.columns(["agent_id"]).doUpdateSet({ last_started_at: ts }))
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `INSERT INTO agent_bridge_state (agent_id, last_started_at)
     VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET last_started_at = excluded.last_started_at`
  ).run(agentId, ts);
}

export async function setLastError(agentId: string, err: string | null): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("agent_bridge_state")
      .values({ agent_id: agentId, last_error: err })
      .onConflict((oc) => oc.columns(["agent_id"]).doUpdateSet({ last_error: err }))
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `INSERT INTO agent_bridge_state (agent_id, last_error)
     VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET last_error = excluded.last_error`
  ).run(agentId, err);
}
