import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

const NOTION_NAMESPACE = "notion";
const NOTION_TOKEN_KEY = "integration_token";

type KeyValueRow = {
  value?: string;
};

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export async function getNotionToken(): Promise<string | null> {
  try {
    if (isPostgres()) {
      await ensurePostgresBootstrap();
      const row = await getKyselyDb()
        .selectFrom("key_value")
        .select("value")
        .where("namespace", "=", NOTION_NAMESPACE)
        .where("key", "=", NOTION_TOKEN_KEY)
        .executeTakeFirst();
      return typeof row?.value === "string" ? JSON.parse(row.value) : null;
    }

    const db = getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(NOTION_NAMESPACE, NOTION_TOKEN_KEY) as KeyValueRow | undefined;
    return typeof row?.value === "string" ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

export async function setNotionToken(token: string): Promise<void> {
  try {
    if (isPostgres()) {
      await ensurePostgresBootstrap();
      await getKyselyDb()
        .insertInto("key_value")
        .values({
          namespace: NOTION_NAMESPACE,
          key: NOTION_TOKEN_KEY,
          value: JSON.stringify(token),
        })
        .onConflict((oc) => oc.columns(["namespace", "key"]).doNothing())
        .execute();
      return;
    }

    const db = getDbInstance();
    db.prepare("INSERT OR IGNORE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      NOTION_NAMESPACE,
      NOTION_TOKEN_KEY,
      JSON.stringify(token)
    );
  } catch {
    // Non-fatal — token still works in-memory if persistence fails.
  }
}

export async function clearNotionToken(): Promise<void> {
  try {
    if (isPostgres()) {
      await ensurePostgresBootstrap();
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", NOTION_NAMESPACE)
        .where("key", "=", NOTION_TOKEN_KEY)
        .execute();
      return;
    }

    const db = getDbInstance();
    db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
      NOTION_NAMESPACE,
      NOTION_TOKEN_KEY
    );
  } catch {
    // Non-fatal.
  }
}

export async function getNotionConfig(): Promise<{ token: string | null; connected: boolean }> {
  const token = await getNotionToken();
  return { token, connected: token !== null && token.length > 0 };
}
