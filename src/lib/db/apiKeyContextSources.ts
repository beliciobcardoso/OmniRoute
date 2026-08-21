import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export interface ApiKeyContextSource {
  apiKeyId: string;
  sourceType: string;
  token: string | null;
  baseUrl: string | null;
  vaultPath: string | null;
  enabled: boolean;
}

interface ContextSourceRow {
  api_key_id: string;
  source_type: string;
  token: string | null;
  base_url: string | null;
  vault_path: string | null;
  enabled: number;
}

function rowToSource(row: ContextSourceRow): ApiKeyContextSource {
  return {
    apiKeyId: row.api_key_id,
    sourceType: row.source_type,
    token: row.token,
    baseUrl: row.base_url,
    vaultPath: row.vault_path,
    enabled: row.enabled === 1,
  };
}

export async function getApiKeyContextSource(
  apiKeyId: string | null | undefined,
  sourceType: string
): Promise<(ApiKeyContextSource & { enabled: true }) | null> {
  if (!apiKeyId) return null;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("api_key_context_sources")
      .selectAll()
      .where("api_key_id", "=", apiKeyId)
      .where("source_type", "=", sourceType)
      .where("enabled", "=", 1)
      .executeTakeFirst();
    if (!row) return null;
    return rowToSource({ ...row, enabled: Number(row.enabled) }) as ApiKeyContextSource & {
      enabled: true;
    };
  }

  const db = getDbInstance();
  const row = db
    .prepare(
      "SELECT * FROM api_key_context_sources WHERE api_key_id = ? AND source_type = ? AND enabled = 1"
    )
    .get(apiKeyId, sourceType) as ContextSourceRow | undefined;
  if (!row) return null;
  return rowToSource(row) as ApiKeyContextSource & { enabled: true };
}

export async function setApiKeyContextSource(
  apiKeyId: string,
  sourceType: string,
  config: { token?: string; baseUrl?: string; vaultPath?: string; enabled?: boolean }
): Promise<void> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const existingPg = await kdb
      .selectFrom("api_key_context_sources")
      .select("api_key_id")
      .where("api_key_id", "=", apiKeyId)
      .where("source_type", "=", sourceType)
      .executeTakeFirst();

    if (existingPg) {
      const set: Record<string, unknown> = { updated_at: now };
      if (config.token !== undefined) set.token = config.token;
      if (config.baseUrl !== undefined) set.base_url = config.baseUrl;
      if (config.vaultPath !== undefined) set.vault_path = config.vaultPath;
      if (config.enabled !== undefined) set.enabled = config.enabled ? 1 : 0;

      await kdb
        .updateTable("api_key_context_sources")
        .set(set as any)
        .where("api_key_id", "=", apiKeyId)
        .where("source_type", "=", sourceType)
        .execute();
    } else {
      await kdb
        .insertInto("api_key_context_sources")
        .values({
          api_key_id: apiKeyId,
          source_type: sourceType,
          token: config.token ?? null,
          base_url: config.baseUrl ?? null,
          vault_path: config.vaultPath ?? null,
          enabled: config.enabled !== undefined ? (config.enabled ? 1 : 0) : 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    return;
  }

  const db = getDbInstance();
  const existing = db
    .prepare("SELECT * FROM api_key_context_sources WHERE api_key_id = ? AND source_type = ?")
    .get(apiKeyId, sourceType) as ContextSourceRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE api_key_context_sources SET
        token = COALESCE(?, token),
        base_url = COALESCE(?, base_url),
        vault_path = COALESCE(?, vault_path),
        enabled = COALESCE(?, enabled),
        updated_at = ?
      WHERE api_key_id = ? AND source_type = ?`
    ).run(
      config.token ?? null,
      config.baseUrl ?? null,
      config.vaultPath ?? null,
      config.enabled !== undefined ? (config.enabled ? 1 : 0) : null,
      now,
      apiKeyId,
      sourceType
    );
  } else {
    db.prepare(
      `INSERT INTO api_key_context_sources
        (api_key_id, source_type, token, base_url, vault_path, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      apiKeyId,
      sourceType,
      config.token ?? null,
      config.baseUrl ?? null,
      config.vaultPath ?? null,
      config.enabled !== undefined ? (config.enabled ? 1 : 0) : 1,
      now,
      now
    );
  }
}

export async function deleteApiKeyContextSource(
  apiKeyId: string,
  sourceType: string
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("api_key_context_sources")
      .where("api_key_id", "=", apiKeyId)
      .where("source_type", "=", sourceType)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM api_key_context_sources WHERE api_key_id = ? AND source_type = ?").run(
    apiKeyId,
    sourceType
  );
}

export async function listApiKeyContextSources(apiKeyId: string): Promise<ApiKeyContextSource[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("api_key_context_sources")
      .selectAll()
      .where("api_key_id", "=", apiKeyId)
      .execute();
    return rows.map((row) => rowToSource({ ...row, enabled: Number(row.enabled) }));
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM api_key_context_sources WHERE api_key_id = ?")
    .all(apiKeyId) as ContextSourceRow[];
  return rows.map(rowToSource);
}
