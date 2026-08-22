import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

interface SecretRow {
  value?: string;
}

export async function getPersistedSecret(key: string): Promise<string | null> {
  try {
    if (isPostgres()) {
      await ensurePostgresBootstrap();
      const kdb = getKyselyDb();
      const row = await kdb
        .selectFrom("key_value")
        .select("value")
        .where("namespace", "=", "secrets")
        .where("key", "=", key)
        .executeTakeFirst();
      return typeof row?.value === "string" ? JSON.parse(row.value) : null;
    }

    const db = getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'secrets' AND key = ?")
      .get(key) as SecretRow | undefined;
    return typeof row?.value === "string" ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

export async function persistSecret(key: string, value: string): Promise<void> {
  try {
    if (isPostgres()) {
      await ensurePostgresBootstrap();
      const kdb = getKyselyDb();
      await kdb
        .insertInto("key_value")
        .values({ namespace: "secrets", key, value: JSON.stringify(value) })
        .onConflict((oc) => oc.columns(["namespace", "key"]).doNothing())
        .execute();
      return;
    }

    const db = getDbInstance();
    db.prepare(
      "INSERT OR IGNORE INTO key_value (namespace, key, value) VALUES ('secrets', ?, ?)"
    ).run(key, JSON.stringify(value));
  } catch {
    // Non-fatal: secrets still work for the current process if persistence fails.
  }
}
