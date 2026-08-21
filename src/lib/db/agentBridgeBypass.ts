/**
 * Database module: AgentBridgeBypass
 * CRUD + seed for agent_bridge_bypass table.
 */

import { getDbInstance } from "./core.ts";
import type { AgentBridgeBypassRow } from "./_rowTypes.ts";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// SQLite rows have source as plain string
interface AgentBridgeBypassDbRow {
  pattern: string;
  source: string;
  created_at: string;
}

function mapRow(row: AgentBridgeBypassDbRow): AgentBridgeBypassRow {
  return {
    pattern: row.pattern,
    source: row.source as "default" | "user",
    created_at: row.created_at,
  };
}

export async function getAllBypassPatterns(): Promise<AgentBridgeBypassRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("agent_bridge_bypass")
      .select(["pattern", "source", "created_at"])
      .orderBy("source", "asc")
      .orderBy("pattern", "asc")
      .execute();
    return rows.map((r) => mapRow(r as unknown as AgentBridgeBypassDbRow));
  }

  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT pattern, source, created_at FROM agent_bridge_bypass ORDER BY source ASC, pattern ASC"
    )
    .all() as AgentBridgeBypassDbRow[];
  return rows.map(mapRow);
}

export async function getUserBypassPatterns(): Promise<string[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("agent_bridge_bypass")
      .select("pattern")
      .where("source", "=", "user")
      .orderBy("pattern", "asc")
      .execute();
    return rows.map((r) => r.pattern);
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT pattern FROM agent_bridge_bypass WHERE source = 'user' ORDER BY pattern ASC")
    .all() as Array<{ pattern: string }>;
  return rows.map((r) => r.pattern);
}

export async function replaceUserBypassPatterns(patterns: string[]): Promise<void> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .transaction()
      .execute(async (trx) => {
        await trx.deleteFrom("agent_bridge_bypass").where("source", "=", "user").execute();
        if (patterns.length > 0) {
          await trx
            .insertInto("agent_bridge_bypass")
            .values(patterns.map((pattern) => ({ pattern, source: "user", created_at: now })))
            .execute();
        }
      });
    return;
  }

  const db = getDbInstance();
  const deleteUserStmt = db.prepare("DELETE FROM agent_bridge_bypass WHERE source = 'user'");
  const insertStmt = db.prepare(
    `INSERT INTO agent_bridge_bypass (pattern, source, created_at) VALUES (?, 'user', ?)`
  );

  const runTransaction = db.transaction(() => {
    deleteUserStmt.run();
    for (const pattern of patterns) {
      insertStmt.run(pattern, now);
    }
  });

  runTransaction();
}

/**
 * Seeds default bypass patterns — idempotent.
 * Only inserts a pattern if it does not already exist in the table.
 * Called at app boot by the AgentBridge manager (F3 will wire this).
 */
export async function seedDefaultBypassPatterns(defaults: string[]): Promise<void> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    if (defaults.length > 0) {
      await getKyselyDb()
        .insertInto("agent_bridge_bypass")
        .values(defaults.map((pattern) => ({ pattern, source: "default", created_at: now })))
        .onConflict((oc) => oc.column("pattern").doNothing())
        .execute();
    }
    return;
  }

  const db = getDbInstance();
  const insertIfMissing = db.prepare(
    `INSERT OR IGNORE INTO agent_bridge_bypass (pattern, source, created_at) VALUES (?, 'default', ?)`
  );

  const runTransaction = db.transaction(() => {
    for (const pattern of defaults) {
      insertIfMissing.run(pattern, now);
    }
  });

  runTransaction();
}
