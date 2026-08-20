/**
 * Database module: AgentBridgeMappings
 * CRUD operations for agent_bridge_mappings table.
 */

import { getDbInstance } from "./core";
import type { AgentBridgeMappingRow } from "./_rowTypes";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

export async function getMappingsForAgent(agentId: string): Promise<AgentBridgeMappingRow[]> {
  if (resolveDbDriverConfig().driver === "postgres") {
    return getMappingsForAgentPostgres(agentId);
  }

  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT agent_id, source_model, target_model, updated_at FROM agent_bridge_mappings WHERE agent_id = ? ORDER BY source_model ASC"
    )
    .all(agentId) as AgentBridgeMappingRow[];
  return rows;
}

async function getMappingsForAgentPostgres(agentId: string): Promise<AgentBridgeMappingRow[]> {
  await ensurePostgresBootstrap();
  const rows = await getKyselyDb()
    .selectFrom("agent_bridge_mappings")
    .select(["agent_id", "source_model", "target_model", "updated_at"])
    .where("agent_id", "=", agentId)
    .orderBy("source_model", "asc")
    .execute();
  return rows as AgentBridgeMappingRow[];
}

export async function setMappings(
  agentId: string,
  mappings: Array<{ source: string; target: string }>
): Promise<void> {
  if (resolveDbDriverConfig().driver === "postgres") {
    return setMappingsPostgres(agentId, mappings);
  }

  const db = getDbInstance();
  const now = new Date().toISOString();

  const deleteStmt = db.prepare("DELETE FROM agent_bridge_mappings WHERE agent_id = ?");
  const insertStmt = db.prepare(
    `INSERT INTO agent_bridge_mappings (agent_id, source_model, target_model, updated_at)
     VALUES (?, ?, ?, ?)`
  );

  const runTransaction = db.transaction(() => {
    deleteStmt.run(agentId);
    for (const mapping of mappings) {
      insertStmt.run(agentId, mapping.source, mapping.target, now);
    }
  });

  runTransaction();
}

async function setMappingsPostgres(
  agentId: string,
  mappings: Array<{ source: string; target: string }>
): Promise<void> {
  await ensurePostgresBootstrap();
  const now = new Date().toISOString();
  const db = getKyselyDb();

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("agent_bridge_mappings").where("agent_id", "=", agentId).execute();
    if (mappings.length === 0) return;
    await trx
      .insertInto("agent_bridge_mappings")
      .values(
        mappings.map((mapping) => ({
          agent_id: agentId,
          source_model: mapping.source,
          target_model: mapping.target,
          updated_at: now,
        }))
      )
      .execute();
  });
}

export async function deleteMapping(agentId: string, source: string): Promise<void> {
  if (resolveDbDriverConfig().driver === "postgres") {
    return deleteMappingPostgres(agentId, source);
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM agent_bridge_mappings WHERE agent_id = ? AND source_model = ?").run(
    agentId,
    source
  );
}

async function deleteMappingPostgres(agentId: string, source: string): Promise<void> {
  await ensurePostgresBootstrap();
  await getKyselyDb()
    .deleteFrom("agent_bridge_mappings")
    .where("agent_id", "=", agentId)
    .where("source_model", "=", source)
    .execute();
}
