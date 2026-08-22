import { getDbInstance, isBuildPhase, isCloud } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

type JsonRecord = Record<string, unknown>;

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  transaction: <T extends (...args: any[]) => unknown>(fn: T) => T;
}

interface KeyValueRow {
  key: string;
  value: string;
}

export interface ProviderLimitsCacheEntry {
  quotas: JsonRecord | null;
  plan: unknown;
  message: string | null;
  fetchedAt: string;
  source?: string | null;
  bankedResetCredits?: number;
}

const PROVIDER_LIMITS_CACHE_NAMESPACE = "providerLimitsCache";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function normalizeCacheEntry(value: unknown): ProviderLimitsCacheEntry | null {
  const record = toRecord(value);
  if (!record) return null;

  const fetchedAt =
    typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? record.fetchedAt : null;
  if (!fetchedAt) return null;

  const bankedResetCredits = Number(record.bankedResetCredits);

  return {
    quotas: toRecord(record.quotas),
    plan: record.plan ?? null,
    message: typeof record.message === "string" ? record.message : null,
    fetchedAt,
    source: typeof record.source === "string" ? record.source : null,
    ...(Number.isFinite(bankedResetCredits) ? { bankedResetCredits } : {}),
  };
}

export async function getProviderLimitsCache(
  connectionId: string
): Promise<ProviderLimitsCacheEntry | null> {
  if (isBuildPhase || isCloud) return null;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("key_value")
      .select("value")
      .where("namespace", "=", PROVIDER_LIMITS_CACHE_NAMESPACE)
      .where("key", "=", connectionId)
      .executeTakeFirst();
    if (!row?.value) return null;
    return normalizeCacheEntry(parseJson(row.value));
  }

  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(PROVIDER_LIMITS_CACHE_NAMESPACE, connectionId) as KeyValueRow | undefined;
  if (!row?.value) return null;
  return normalizeCacheEntry(parseJson(row.value));
}

export async function getAllProviderLimitsCache(): Promise<
  Record<string, ProviderLimitsCacheEntry>
> {
  if (isBuildPhase || isCloud) return {};

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("key_value")
      .select(["key", "value"])
      .where("namespace", "=", PROVIDER_LIMITS_CACHE_NAMESPACE)
      .execute();

    const result: Record<string, ProviderLimitsCacheEntry> = {};
    for (const row of rows) {
      const parsed = normalizeCacheEntry(parseJson(row.value));
      if (parsed) {
        result[row.key] = parsed;
      }
    }
    return result;
  }

  const db = getDbInstance() as unknown as DbLike;
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(PROVIDER_LIMITS_CACHE_NAMESPACE) as KeyValueRow[];

  const result: Record<string, ProviderLimitsCacheEntry> = {};
  for (const row of rows) {
    const parsed = normalizeCacheEntry(parseJson(row.value));
    if (parsed) {
      result[row.key] = parsed;
    }
  }
  return result;
}

export async function setProviderLimitsCache(
  connectionId: string,
  entry: ProviderLimitsCacheEntry
): Promise<ProviderLimitsCacheEntry> {
  if (isBuildPhase || isCloud) return entry;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({
        namespace: PROVIDER_LIMITS_CACHE_NAMESPACE,
        key: connectionId,
        value: JSON.stringify(entry),
      })
      .onConflict((oc) =>
        oc.columns(["namespace", "key"]).doUpdateSet({ value: JSON.stringify(entry) })
      )
      .execute();
    return entry;
  }

  const db = getDbInstance() as unknown as DbLike;
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    PROVIDER_LIMITS_CACHE_NAMESPACE,
    connectionId,
    JSON.stringify(entry)
  );
  return entry;
}

export async function setProviderLimitsCacheBatch(
  entries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>
): Promise<number> {
  if (isBuildPhase || isCloud || entries.length === 0) return 0;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .transaction()
      .execute(async (trx) => {
        for (const item of entries) {
          await trx
            .insertInto("key_value")
            .values({
              namespace: PROVIDER_LIMITS_CACHE_NAMESPACE,
              key: item.connectionId,
              value: JSON.stringify(item.entry),
            })
            .onConflict((oc) =>
              oc.columns(["namespace", "key"]).doUpdateSet({ value: JSON.stringify(item.entry) })
            )
            .execute();
        }
      });
    return entries.length;
  }

  const db = getDbInstance() as unknown as DbLike;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
  );
  const tx = db.transaction(
    (items: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>) => {
      for (const item of items) {
        insert.run(PROVIDER_LIMITS_CACHE_NAMESPACE, item.connectionId, JSON.stringify(item.entry));
      }
    }
  );
  tx(entries);
  return entries.length;
}

export async function deleteProviderLimitsCache(connectionId: string): Promise<void> {
  if (isBuildPhase || isCloud) return;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("key_value")
      .where("namespace", "=", PROVIDER_LIMITS_CACHE_NAMESPACE)
      .where("key", "=", connectionId)
      .execute();
    return;
  }

  const db = getDbInstance() as unknown as DbLike;
  db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
    PROVIDER_LIMITS_CACHE_NAMESPACE,
    connectionId
  );
}
