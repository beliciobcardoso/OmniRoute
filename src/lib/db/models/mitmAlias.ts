/** db/models/mitmAlias.ts — MITM alias CRUD (mitmAlias namespace). */

import { getDbInstance } from "../core";
import { backupDbFile } from "../backup";
import { getKeyValue } from "./shared";
import { resolveDbDriverConfig } from "../driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "../kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export async function getMitmAlias(toolName?: string) {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    if (toolName) {
      const row = await kdb
        .selectFrom("key_value")
        .select("value")
        .where("namespace", "=", "mitmAlias")
        .where("key", "=", toolName)
        .executeTakeFirst();
      const value = getKeyValue(row).value;
      return value ? JSON.parse(value) : {};
    }
    const rows = await kdb
      .selectFrom("key_value")
      .select(["key", "value"])
      .where("namespace", "=", "mitmAlias")
      .execute();
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      const { key, value } = getKeyValue(row);
      if (!key || value === null) continue;
      result[key] = JSON.parse(value);
    }
    return result;
  }
  const db = getDbInstance();
  if (toolName) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'mitmAlias' AND key = ?")
      .get(toolName);
    const value = getKeyValue(row).value;
    return value ? JSON.parse(value) : {};
  }
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'mitmAlias'").all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || value === null) continue;
    result[key] = JSON.parse(value);
  }
  return result;
}

export async function setMitmAliasAll(toolName: string, mappings: unknown) {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("key_value")
      .values({
        namespace: "mitmAlias",
        key: toolName,
        value: JSON.stringify(mappings || {}),
      })
      .onConflict((oc) =>
        oc.columns(["namespace", "key"]).doUpdateSet({ value: (eb) => eb.ref("excluded.value") })
      )
      .execute();
    return;
  }
  const db = getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('mitmAlias', ?, ?)"
  ).run(toolName, JSON.stringify(mappings || {}));
  backupDbFile("pre-write");
}
