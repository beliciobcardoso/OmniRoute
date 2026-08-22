/**
 * Database module: InspectorCustomHosts
 * CRUD operations for inspector_custom_hosts table.
 */

import { getDbInstance } from "./core.ts";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";
import type { SqliteBoolean } from "./kysely/types.ts";
import type { InspectorCustomHostRow } from "./_rowTypes.ts";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// SQLite stores booleans as integers
interface InspectorCustomHostDbRow {
  host: string;
  enabled: number;
  label: string | null;
  kind: string;
  added_at: string;
  last_seen_at: string | null;
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function mapRow(row: InspectorCustomHostDbRow): InspectorCustomHostRow {
  return {
    host: row.host,
    enabled: toBool(row.enabled),
    label: row.label,
    kind: row.kind as "llm" | "app" | "custom",
    added_at: row.added_at,
    last_seen_at: row.last_seen_at,
  };
}

export async function listCustomHosts(opts?: {
  enabledOnly?: boolean;
}): Promise<InspectorCustomHostRow[]> {
  const enabledOnly = opts?.enabledOnly === true;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    let query = kdb.selectFrom("inspector_custom_hosts").selectAll();
    if (enabledOnly) query = query.where("enabled", "=", 1 as unknown as SqliteBoolean);
    const rows = await query.orderBy("host", "asc").execute();
    return rows.map((r) =>
      mapRow({
        host: r.host,
        enabled: toBool(r.enabled) ? 1 : 0,
        label: r.label,
        kind: r.kind,
        added_at: r.added_at,
        last_seen_at: r.last_seen_at,
      })
    );
  }

  const db = getDbInstance();
  const rows = enabledOnly
    ? (db
        .prepare("SELECT * FROM inspector_custom_hosts WHERE enabled = 1 ORDER BY host ASC")
        .all() as InspectorCustomHostDbRow[])
    : (db
        .prepare("SELECT * FROM inspector_custom_hosts ORDER BY host ASC")
        .all() as InspectorCustomHostDbRow[]);

  return rows.map(mapRow);
}

export async function addCustomHost(
  host: string,
  kind: "llm" | "app" | "custom" = "custom",
  label?: string
): Promise<void> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("inspector_custom_hosts")
      .values({
        host,
        enabled: 1 as unknown as SqliteBoolean,
        label: label ?? null,
        kind,
        added_at: now,
      })
      .onConflict((oc) => oc.columns(["host"]).doNothing())
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    `INSERT OR IGNORE INTO inspector_custom_hosts (host, enabled, label, kind, added_at)
     VALUES (?, 1, ?, ?, ?)`
  ).run(host, label ?? null, kind, now);
}

export async function removeCustomHost(host: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb.deleteFrom("inspector_custom_hosts").where("host", "=", host).execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM inspector_custom_hosts WHERE host = ?").run(host);
}

export async function toggleCustomHost(host: string, enabled: boolean): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .updateTable("inspector_custom_hosts")
      .set({ enabled: (enabled ? 1 : 0) as unknown as SqliteBoolean })
      .where("host", "=", host)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("UPDATE inspector_custom_hosts SET enabled = ? WHERE host = ?").run(
    enabled ? 1 : 0,
    host
  );
}

export async function touchLastSeen(host: string): Promise<void> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .updateTable("inspector_custom_hosts")
      .set({ last_seen_at: now })
      .where("host", "=", host)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("UPDATE inspector_custom_hosts SET last_seen_at = ? WHERE host = ?").run(now, host);
}

/**
 * Returns true when `host` is present in inspector_custom_hosts with enabled=1.
 * Used by agentBridgeHook to distinguish custom-host intercepts from agent-bridge
 * intercepts so that Mode 2 (Custom Hosts) entries appear in the "Custom" profile.
 */
export async function isCustomHost(host: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("inspector_custom_hosts")
      .select("enabled")
      .where("host", "=", host)
      .executeTakeFirst();
    return row !== undefined && toBool(row.enabled);
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT 1 AS found FROM inspector_custom_hosts WHERE host = ? AND enabled = 1")
    .get(host) as { found: number } | undefined;
  return row !== undefined;
}
