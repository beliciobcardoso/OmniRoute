import { getDbInstance } from "./core";
import { getApiKeyContextSource } from "./apiKeyContextSources";
import { encrypt, decrypt } from "./encryption";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

const OBSIDIAN_NAMESPACE = "obsidian";
const OBSIDIAN_TOKEN_KEY = "api_key";

type KeyValueRow = {
  value?: string;
};

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

/** Raw (still-JSON-encoded) key_value read, scoped to the obsidian namespace. */
async function kvGet(key: string): Promise<string | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("key_value")
      .select("value")
      .where("namespace", "=", OBSIDIAN_NAMESPACE)
      .where("key", "=", key)
      .executeTakeFirst();
    return typeof row?.value === "string" ? row.value : null;
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(OBSIDIAN_NAMESPACE, key) as KeyValueRow | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

/** Raw (already-JSON-encoded) key_value upsert, scoped to the obsidian namespace. */
async function kvSet(key: string, jsonValue: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: OBSIDIAN_NAMESPACE, key, value: jsonValue })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value: jsonValue }))
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    OBSIDIAN_NAMESPACE,
    key,
    jsonValue
  );
}

async function kvClear(key: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("key_value")
      .where("namespace", "=", OBSIDIAN_NAMESPACE)
      .where("key", "=", key)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(OBSIDIAN_NAMESPACE, key);
}

export async function getObsidianToken(): Promise<string | null> {
  try {
    const value = await kvGet(OBSIDIAN_TOKEN_KEY);
    if (value === null) return null;
    const parsed = JSON.parse(value);
    if (typeof parsed !== "string" || parsed.length === 0) return null;
    // Graceful fallback: if decrypt fails (e.g. no key set) return as-is
    return decrypt(parsed) ?? parsed;
  } catch {
    return null;
  }
}

export async function setObsidianToken(token: string): Promise<void> {
  try {
    const encrypted = encrypt(token) ?? token;
    await kvSet(OBSIDIAN_TOKEN_KEY, JSON.stringify(encrypted));
  } catch {
    // Non-fatal — token still works in-memory if persistence fails.
  }
}

export async function clearObsidianToken(): Promise<void> {
  try {
    await kvClear(OBSIDIAN_TOKEN_KEY);
  } catch {
    // Non-fatal.
  }
}

export async function getObsidianBaseUrl(): Promise<string> {
  try {
    const value = await kvGet("base_url");
    if (value === null) return "http://127.0.0.1:27123";
    const parsed = JSON.parse(value);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : "http://127.0.0.1:27123";
  } catch {
    return "http://127.0.0.1:27123";
  }
}

export async function setObsidianBaseUrl(url: string): Promise<void> {
  try {
    await kvSet("base_url", JSON.stringify(url));
  } catch {
    // Non-fatal.
  }
}

export async function clearObsidianBaseUrl(): Promise<void> {
  try {
    await kvClear("base_url");
  } catch {
    // Non-fatal.
  }
}

export async function getObsidianVaultPath(): Promise<string | null> {
  try {
    const value = await kvGet("vault_path");
    if (value === null) return null;
    const parsed = JSON.parse(value);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function setObsidianVaultPath(vaultPath: string): Promise<void> {
  try {
    await kvSet("vault_path", JSON.stringify(vaultPath));
  } catch {
    // Non-fatal.
  }
}

export async function clearObsidianVaultPath(): Promise<void> {
  try {
    await kvClear("vault_path");
  } catch {
    // Non-fatal.
  }
}

export async function getWebdavUsername(): Promise<string | null> {
  try {
    const value = await kvGet("webdav_username");
    if (value === null) return null;
    const parsed = JSON.parse(value);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function setWebdavUsername(username: string): Promise<void> {
  try {
    await kvSet("webdav_username", JSON.stringify(username));
  } catch {
    // Non-fatal.
  }
}

export async function clearWebdavUsername(): Promise<void> {
  try {
    await kvClear("webdav_username");
  } catch {
    // Non-fatal.
  }
}

export async function getWebdavPassword(): Promise<string | null> {
  try {
    const value = await kvGet("webdav_password");
    if (value === null) return null;
    const parsed = JSON.parse(value);
    if (typeof parsed !== "string" || parsed.length === 0) return null;
    // Graceful fallback: if decrypt fails return as-is (plaintext backward compat)
    return decrypt(parsed) ?? parsed;
  } catch {
    return null;
  }
}

export async function setWebdavPassword(password: string): Promise<void> {
  try {
    const encrypted = encrypt(password) ?? password;
    await kvSet("webdav_password", JSON.stringify(encrypted));
  } catch {
    // Non-fatal.
  }
}

export async function clearWebdavPassword(): Promise<void> {
  try {
    await kvClear("webdav_password");
  } catch {
    // Non-fatal.
  }
}

export async function getWebdavEnabled(): Promise<boolean> {
  try {
    const value = await kvGet("webdav_enabled");
    return value !== null && JSON.parse(value) === true;
  } catch {
    return false;
  }
}

export async function setWebdavEnabled(enabled: boolean): Promise<void> {
  try {
    await kvSet("webdav_enabled", JSON.stringify(enabled));
  } catch {
    // Non-fatal.
  }
}

export async function clearWebdavEnabled(): Promise<void> {
  try {
    await kvClear("webdav_enabled");
  } catch {
    // Non-fatal.
  }
}

export async function getObsidianConfig(): Promise<{
  token: string | null;
  connected: boolean;
  baseUrl: string;
  vaultPath: string | null;
}> {
  const [token, baseUrl, vaultPath] = await Promise.all([
    getObsidianToken(),
    getObsidianBaseUrl(),
    getObsidianVaultPath(),
  ]);
  return { token, connected: token !== null && token.length > 0, baseUrl, vaultPath };
}

export async function getObsidianConfigForApiKey(apiKeyId: string | null | undefined): Promise<{
  token: string | null;
  baseUrl: string;
  vaultPath: string | null;
  source: "api_key" | "global";
}> {
  if (apiKeyId) {
    try {
      const perKey = await getApiKeyContextSource(apiKeyId, "obsidian");
      if (perKey && perKey.enabled && perKey.token) {
        const [baseUrl, vaultPath] = await Promise.all([
          perKey.baseUrl ? Promise.resolve(perKey.baseUrl) : getObsidianBaseUrl(),
          perKey.vaultPath ? Promise.resolve(perKey.vaultPath) : getObsidianVaultPath(),
        ]);
        return { token: perKey.token, baseUrl, vaultPath, source: "api_key" };
      }
    } catch {
      // Per-key config not available — fall through to global
    }
  }
  const [token, baseUrl, vaultPath] = await Promise.all([
    getObsidianToken(),
    getObsidianBaseUrl(),
    getObsidianVaultPath(),
  ]);
  return { token, baseUrl, vaultPath, source: "global" };
}
