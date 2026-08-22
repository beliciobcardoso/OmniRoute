import { randomUUID } from "crypto";
import { getDbInstance } from "./core";
import { backupDbFile } from "./backup";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";
import type { FreeProxyItem, FreeProxySourceId } from "@/lib/freeProxyProviders/types";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// Postgres BIGINT columns (port, quality_score, latency_ms, in_pool) come back
// as JS strings from node-postgres, not numbers — coerce before any numeric
// comparison or boolean check (e.g. `in_pool === 1` silently breaks on "1").
function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return toInt(value);
}

export interface FreeProxyRecord {
  id: string;
  source: FreeProxySourceId;
  host: string;
  port: number;
  type: string;
  countryCode: string | null;
  qualityScore: number | null;
  latencyMs: number | null;
  anonymity: string | null;
  lastValidated: string | null;
  inPool: boolean;
  poolProxyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FreeProxyStats {
  total: number;
  inPool: number;
  avgQuality: number | null;
  bySource: Array<{ source: string; count: number }>;
  lastSyncAt: string | null;
}

/** Source id → list of error messages from that source's last sync. */
export type FreeProxySyncErrors = Record<string, string[]>;

type DbRow = Record<string, unknown>;

function mapRow(row: unknown): FreeProxyRecord {
  const r = row as DbRow;
  return {
    id: String(r.id ?? ""),
    source: String(r.source ?? "1proxy") as FreeProxySourceId,
    host: String(r.host ?? ""),
    port: toInt(r.port),
    type: String(r.type ?? "http"),
    countryCode: r.country_code != null ? String(r.country_code) : null,
    qualityScore: toIntOrNull(r.quality_score),
    latencyMs: toIntOrNull(r.latency_ms),
    anonymity: r.anonymity != null ? String(r.anonymity) : null,
    lastValidated: r.last_validated != null ? String(r.last_validated) : null,
    inPool: r.in_pool === true || toInt(r.in_pool) === 1,
    poolProxyId: r.pool_proxy_id != null ? String(r.pool_proxy_id) : null,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function upsertFreeProxy(
  item: FreeProxyItem
): Promise<{ id: string; action: "created" | "updated" }> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const existing = await kdb
      .selectFrom("free_proxies")
      .select("id")
      .where("source", "=", item.source)
      .where("host", "=", item.host)
      .where("port", "=", item.port)
      .executeTakeFirst();

    if (existing?.id) {
      await kdb
        .updateTable("free_proxies")
        .set({
          type: item.type,
          country_code: item.countryCode ?? null,
          quality_score: item.qualityScore ?? null,
          latency_ms: item.latencyMs ?? null,
          anonymity: item.anonymity ?? null,
          last_validated: item.lastValidated ?? now,
          updated_at: now,
        })
        .where("id", "=", existing.id)
        .execute();
      return { id: existing.id, action: "updated" };
    }

    const id = randomUUID();
    await kdb
      .insertInto("free_proxies")
      .values({
        id,
        source: item.source,
        host: item.host,
        port: item.port,
        type: item.type,
        country_code: item.countryCode ?? null,
        quality_score: item.qualityScore ?? null,
        latency_ms: item.latencyMs ?? null,
        anonymity: item.anonymity ?? null,
        last_validated: item.lastValidated ?? now,
        in_pool: 0,
        pool_proxy_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { id, action: "created" };
  }

  const db = getDbInstance();

  const existing = db
    .prepare("SELECT id FROM free_proxies WHERE source = ? AND host = ? AND port = ?")
    .get(item.source, item.host, item.port) as { id?: string } | undefined;

  if (existing?.id) {
    db.prepare(
      `UPDATE free_proxies
       SET type = ?, country_code = ?, quality_score = ?, latency_ms = ?,
           anonymity = ?, last_validated = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      item.type,
      item.countryCode ?? null,
      item.qualityScore ?? null,
      item.latencyMs ?? null,
      item.anonymity ?? null,
      item.lastValidated ?? now,
      now,
      existing.id
    );
    return { id: existing.id, action: "updated" };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO free_proxies
     (id, source, host, port, type, country_code, quality_score, latency_ms,
      anonymity, last_validated, in_pool, pool_proxy_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
  ).run(
    id,
    item.source,
    item.host,
    item.port,
    item.type,
    item.countryCode ?? null,
    item.qualityScore ?? null,
    item.latencyMs ?? null,
    item.anonymity ?? null,
    item.lastValidated ?? now,
    now,
    now
  );
  return { id, action: "created" };
}

export async function listFreeProxies(options?: {
  sources?: FreeProxySourceId[];
  protocol?: string;
  country?: string;
  minQuality?: number;
  onlyInPool?: boolean;
  onlyNotInPool?: boolean;
  search?: string;
  sortBy?: "quality" | "latency" | "recent";
  limit?: number;
  offset?: number;
}): Promise<FreeProxyRecord[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().selectFrom("free_proxies").selectAll();

    if (options?.sources?.length) {
      query = query.where("source", "in", options.sources);
    }
    if (options?.protocol) {
      query = query.where("type", "=", options.protocol);
    }
    if (options?.country) {
      query = query.where("country_code", "=", options.country.toUpperCase());
    }
    if (options?.minQuality != null) {
      query = query.where("quality_score", ">=", options.minQuality);
    }
    if (options?.onlyInPool) {
      query = query.where("in_pool", "=", 1);
    }
    if (options?.onlyNotInPool) {
      query = query.where("in_pool", "=", 0);
    }
    if (options?.search) {
      query = query.where("host", "like", `%${options.search}%`);
    }

    if (options?.sortBy === "latency") {
      query = query
        .orderBy((eb) => eb.case().when("latency_ms", "is", null).then(0).else(1).end())
        .orderBy("latency_ms", "asc");
    } else if (options?.sortBy === "recent") {
      query = query.orderBy("last_validated", "desc");
    } else {
      query = query.orderBy("quality_score", "desc").orderBy("last_validated", "desc");
    }

    if (options?.limit) {
      query = query.limit(options.limit);
      if (options?.offset) {
        query = query.offset(options.offset);
      }
    }

    const rows = await query.execute();
    return rows.map(mapRow);
  }

  const db = getDbInstance();
  const params: unknown[] = [];
  let sql = "SELECT * FROM free_proxies WHERE 1=1";

  if (options?.sources?.length) {
    sql += ` AND source IN (${options.sources.map(() => "?").join(",")})`;
    params.push(...options.sources);
  }
  if (options?.protocol) {
    sql += " AND type = ?";
    params.push(options.protocol);
  }
  if (options?.country) {
    sql += " AND country_code = ?";
    params.push(options.country.toUpperCase());
  }
  if (options?.minQuality != null) {
    sql += " AND quality_score >= ?";
    params.push(options.minQuality);
  }
  if (options?.onlyInPool) {
    sql += " AND in_pool = 1";
  }
  if (options?.onlyNotInPool) {
    sql += " AND in_pool = 0";
  }
  if (options?.search) {
    sql += " AND host LIKE ?";
    params.push(`%${options.search}%`);
  }

  const sortClause =
    options?.sortBy === "latency"
      ? "ORDER BY latency_ms IS NULL, latency_ms ASC"
      : options?.sortBy === "recent"
        ? "ORDER BY last_validated DESC"
        : "ORDER BY quality_score DESC, last_validated DESC";
  sql += ` ${sortClause}`;

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
    if (options?.offset) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapRow);
}

export async function countFreeProxies(options?: {
  sources?: FreeProxySourceId[];
  protocol?: string;
  country?: string;
  minQuality?: number;
  onlyInPool?: boolean;
  onlyNotInPool?: boolean;
  search?: string;
}): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb()
      .selectFrom("free_proxies")
      .select((eb) => eb.fn.countAll().as("count"));

    if (options?.sources?.length) {
      query = query.where("source", "in", options.sources);
    }
    if (options?.protocol) {
      query = query.where("type", "=", options.protocol);
    }
    if (options?.country) {
      query = query.where("country_code", "=", options.country.toUpperCase());
    }
    if (options?.minQuality != null) {
      query = query.where("quality_score", ">=", options.minQuality);
    }
    if (options?.onlyInPool) {
      query = query.where("in_pool", "=", 1);
    }
    if (options?.onlyNotInPool) {
      query = query.where("in_pool", "=", 0);
    }
    if (options?.search) {
      query = query.where("host", "like", `%${options.search}%`);
    }

    const row = await query.executeTakeFirst();
    return row ? Number(row.count) : 0;
  }

  const db = getDbInstance();
  const params: unknown[] = [];
  let sql = "SELECT COUNT(*) AS count FROM free_proxies WHERE 1=1";

  if (options?.sources?.length) {
    sql += ` AND source IN (${options.sources.map(() => "?").join(",")})`;
    params.push(...options.sources);
  }
  if (options?.protocol) {
    sql += " AND type = ?";
    params.push(options.protocol);
  }
  if (options?.country) {
    sql += " AND country_code = ?";
    params.push(options.country.toUpperCase());
  }
  if (options?.minQuality != null) {
    sql += " AND quality_score >= ?";
    params.push(options.minQuality);
  }
  if (options?.onlyInPool) {
    sql += " AND in_pool = 1";
  }
  if (options?.onlyNotInPool) {
    sql += " AND in_pool = 0";
  }
  if (options?.search) {
    sql += " AND host LIKE ?";
    params.push(`%${options.search}%`);
  }

  const row = db.prepare(sql).get(...params) as DbRow | undefined;
  const count = row?.count;
  return typeof count === "number" ? count : Number(count ?? 0);
}

export async function listFreeProxiesBySource(
  source: FreeProxySourceId,
  filters: {
    protocol?: string;
    country?: string;
    minQuality?: number;
    limit?: number;
  }
): Promise<FreeProxyItem[]> {
  const records = await listFreeProxies({
    sources: [source],
    protocol: filters.protocol,
    country: filters.country,
    minQuality: filters.minQuality,
    limit: filters.limit,
  });
  return records.map((r) => ({
    source: r.source,
    host: r.host,
    port: r.port,
    type: r.type as FreeProxyItem["type"],
    countryCode: r.countryCode,
    qualityScore: r.qualityScore,
    latencyMs: r.latencyMs,
    anonymity: r.anonymity,
    lastValidated: r.lastValidated,
  }));
}

export async function getFreeProxyById(id: string): Promise<FreeProxyRecord | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("free_proxies")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM free_proxies WHERE id = ?").get(id);
  return row ? mapRow(row) : null;
}

export async function markFreeProxyInPool(id: string, poolProxyId: string): Promise<void> {
  const now = new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("free_proxies")
      .set({ in_pool: 1, pool_proxy_id: poolProxyId, updated_at: now })
      .where("id", "=", id)
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    "UPDATE free_proxies SET in_pool = 1, pool_proxy_id = ?, updated_at = ? WHERE id = ?"
  ).run(poolProxyId, now, id);
  backupDbFile("pre-write");
}

/**
 * Atomically inserts the free proxy into `proxy_registry` and flips its
 * `in_pool` flag in a single SQLite transaction. Replaces the previous
 * non-atomic `createProxy() + markFreeProxyInPool()` pair which could leave
 * `free_proxies.in_pool=0` while the registry row already existed if the
 * second call failed.
 *
 * Returns the new `poolProxyId` on success, or `null` if the free proxy id
 * does not exist (caller should return 404).
 */
export async function promoteFreeProxyToPool(
  freeProxyId: string,
  registryPayload: {
    name: string;
    type: string;
    host: string;
    port: number;
    source: string;
  }
): Promise<string | null> {
  const now = new Date().toISOString();
  const newRegistryId = randomUUID();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const result = await kdb.transaction().execute(async (trx) => {
      const exists = await trx
        .selectFrom("free_proxies")
        .select(["id", "in_pool"])
        .where("id", "=", freeProxyId)
        .executeTakeFirst();
      if (!exists?.id) return null;

      await trx
        .insertInto("proxy_registry")
        .values({
          id: newRegistryId,
          name: registryPayload.name,
          type: registryPayload.type,
          host: registryPayload.host,
          port: Number(registryPayload.port),
          username: "",
          password: "",
          region: null,
          notes: null,
          status: "active",
          source: registryPayload.source,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await trx
        .updateTable("free_proxies")
        .set({ in_pool: 1, pool_proxy_id: newRegistryId, updated_at: now })
        .where("id", "=", freeProxyId)
        .execute();

      return newRegistryId;
    });
    return result;
  }

  const db = getDbInstance();

  const result = db.transaction(() => {
    const exists = db
      .prepare("SELECT id, in_pool FROM free_proxies WHERE id = ? LIMIT 1")
      .get(freeProxyId) as { id?: string; in_pool?: number } | undefined;
    if (!exists?.id) return null;

    db.prepare(
      `INSERT INTO proxy_registry
        (id, name, type, host, port, username, password, region, notes, status, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', '', NULL, NULL, 'active', ?, ?, ?)`
    ).run(
      newRegistryId,
      registryPayload.name,
      registryPayload.type,
      registryPayload.host,
      Number(registryPayload.port),
      registryPayload.source,
      now,
      now
    );

    db.prepare(
      "UPDATE free_proxies SET in_pool = 1, pool_proxy_id = ?, updated_at = ? WHERE id = ?"
    ).run(newRegistryId, now, freeProxyId);

    return newRegistryId;
  })();

  if (result) backupDbFile("pre-write");
  return result;
}

export async function deleteFreeProxy(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("free_proxies")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance();
  const result = db.prepare("DELETE FROM free_proxies WHERE id = ?").run(id);
  backupDbFile("pre-write");
  return result.changes > 0;
}

export async function clearFreeProxiesBySource(source: FreeProxySourceId): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("free_proxies")
      .where("source", "=", source)
      .where("in_pool", "=", 0)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  const db = getDbInstance();
  const result = db
    .prepare("DELETE FROM free_proxies WHERE source = ? AND in_pool = 0")
    .run(source);
  backupDbFile("pre-write");
  return result.changes;
}

/**
 * Tombstone rows for `source` whose `host:port` is no longer present in the
 * provider's latest list — e.g. Webshare recycles/retires proxy IDs between
 * syncs. Rows already promoted to the pool (`in_pool = 1`) are left alone so
 * runtime resolution of an in-use proxy is never disturbed; only stale,
 * not-yet-pooled candidates are pruned. Returns the number of rows removed.
 */
export async function pruneStaleFreeProxies(
  source: FreeProxySourceId,
  activeKeys: ReadonlySet<string>
): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("free_proxies")
      .select(["id", "host", "port"])
      .where("source", "=", source)
      .where("in_pool", "=", 0)
      .execute();

    const staleIds = rows.filter((r) => !activeKeys.has(`${r.host}:${r.port}`)).map((r) => r.id);
    if (staleIds.length === 0) return 0;

    const result = await kdb
      .deleteFrom("free_proxies")
      .where("id", "in", staleIds)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT id, host, port FROM free_proxies WHERE source = ? AND in_pool = 0")
    .all(source) as Array<{ id: string; host: string; port: number }>;

  const staleIds = rows.filter((r) => !activeKeys.has(`${r.host}:${r.port}`)).map((r) => r.id);

  if (staleIds.length === 0) return 0;

  const placeholders = staleIds.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM free_proxies WHERE id IN (${placeholders})`)
    .run(...staleIds);
  backupDbFile("pre-write");
  return result.changes;
}

// #4878: the displayed "last sync" used to be derived from MAX(last_validated),
// which only advances when a provider returns at least one new/updated proxy. A
// sync that returns zero rows (or whose providers all fail) left the timestamp
// frozen, so "Sync All" appeared to do nothing. We persist an explicit sync
// timestamp in the generic key_value store and prefer it in the stats.
const FREE_PROXY_SYNC_NAMESPACE = "free_proxies";
const FREE_PROXY_SYNC_KEY = "last_sync_at";

/**
 * Persist the moment a free-proxy sync completed. Returns the stored ISO string
 * so the route can echo it back. `at` is overridable for deterministic tests.
 */
export async function recordFreeProxySync(at?: string): Promise<string> {
  const ts = at ?? new Date().toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: FREE_PROXY_SYNC_NAMESPACE, key: FREE_PROXY_SYNC_KEY, value: ts })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value: ts }))
      .execute();
    return ts;
  }

  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    FREE_PROXY_SYNC_NAMESPACE,
    FREE_PROXY_SYNC_KEY,
    ts
  );
  backupDbFile("pre-write");
  return ts;
}

function getRecordedFreeProxySync(db: ReturnType<typeof getDbInstance>): string | null {
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(FREE_PROXY_SYNC_NAMESPACE, FREE_PROXY_SYNC_KEY) as { value?: string } | undefined;
  return row?.value != null ? String(row.value) : null;
}

async function getRecordedFreeProxySyncPostgres(): Promise<string | null> {
  const row = await getKyselyDb()
    .selectFrom("key_value")
    .select("value")
    .where("namespace", "=", FREE_PROXY_SYNC_NAMESPACE)
    .where("key", "=", FREE_PROXY_SYNC_KEY)
    .executeTakeFirst();
  return row?.value != null ? String(row.value) : null;
}

export async function getFreeProxyStats(): Promise<FreeProxyStats> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    const totals = await kdb
      .selectFrom("free_proxies")
      .select((eb) => [
        eb.fn.countAll().as("total"),
        eb.fn.sum(eb.case().when("in_pool", "=", 1).then(1).else(0).end()).as("in_pool_count"),
        eb.fn.avg("quality_score").as("avg_quality"),
        eb.fn.max("last_validated").as("last_sync_at"),
      ])
      .executeTakeFirst();

    const bySource = await kdb
      .selectFrom("free_proxies")
      .select(["source", (eb) => eb.fn.countAll().as("count")])
      .groupBy("source")
      .orderBy("count", "desc")
      .execute();

    const recordedSyncAt = await getRecordedFreeProxySyncPostgres();
    const derivedSyncAt = totals?.last_sync_at != null ? String(totals.last_sync_at) : null;

    return {
      total: totals ? Number(totals.total) || 0 : 0,
      inPool: totals ? Number(totals.in_pool_count) || 0 : 0,
      avgQuality: totals?.avg_quality != null ? Math.round(Number(totals.avg_quality)) : null,
      bySource: bySource.map((r) => ({ source: String(r.source), count: Number(r.count) })),
      lastSyncAt: recordedSyncAt ?? derivedSyncAt,
    };
  }

  const db = getDbInstance();
  const totals = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN in_pool = 1 THEN 1 ELSE 0 END) as in_pool_count,
              AVG(quality_score) as avg_quality,
              MAX(last_validated) as last_sync_at
       FROM free_proxies`
    )
    .get() as DbRow;

  const bySource = db
    .prepare(
      "SELECT source, COUNT(*) as count FROM free_proxies GROUP BY source ORDER BY count DESC"
    )
    .all() as DbRow[];

  // Prefer the explicitly recorded sync timestamp (#4878); fall back to the
  // newest last_validated only when no sync has ever been recorded.
  const recordedSyncAt = getRecordedFreeProxySync(db);
  const derivedSyncAt = totals.last_sync_at != null ? String(totals.last_sync_at) : null;

  return {
    total: Number(totals.total) || 0,
    inPool: Number(totals.in_pool_count) || 0,
    avgQuality: totals.avg_quality != null ? Math.round(Number(totals.avg_quality)) : null,
    bySource: bySource.map((r) => ({ source: String(r.source), count: Number(r.count) })),
    lastSyncAt: recordedSyncAt ?? derivedSyncAt,
  };
}
/**
 * Persist the most recent per-source sync errors. A successful sync for a
 * source should call clearFreeProxySyncErrors instead so the stale error
 * stops showing.
 */
export async function recordFreeProxySyncErrors(
  source: FreeProxySourceId,
  errors: string[]
): Promise<void> {
  const at = new Date().toISOString();
  const payload = JSON.stringify(errors);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("free_proxy_sync_errors")
      .values({ source, errors: payload, updated_at: at })
      .onConflict((oc) => oc.column("source").doUpdateSet({ errors: payload, updated_at: at }))
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO free_proxy_sync_errors (source, errors, updated_at) VALUES (?, ?, ?)"
  ).run(source, payload, at);
  backupDbFile("pre-write");
}

/** Clear a source's stored sync error (called on a successful sync). */
export async function clearFreeProxySyncErrors(source: FreeProxySourceId): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb().deleteFrom("free_proxy_sync_errors").where("source", "=", source).execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM free_proxy_sync_errors WHERE source = ?").run(source);
  backupDbFile("pre-write");
}

/**
 * Read all stored per-source sync errors as a plain map. Sources with no
 * recorded error are omitted, so an empty object means a clean (or un-synced)
 * state.
 */
export async function getFreeProxySyncErrors(): Promise<FreeProxySyncErrors> {
  let rows: Array<{ source: string; errors: string }>;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    rows = await getKyselyDb()
      .selectFrom("free_proxy_sync_errors")
      .select(["source", "errors"])
      .execute();
  } else {
    const db = getDbInstance();
    rows = db.prepare("SELECT source, errors FROM free_proxy_sync_errors").all() as Array<{
      source: string;
      errors: string;
    }>;
  }

  const out: FreeProxySyncErrors = {};
  for (const row of rows) {
    if (!row.source) continue;
    try {
      const parsed = JSON.parse(row.errors) as unknown;
      out[row.source] = Array.isArray(parsed) ? parsed.map(String) : [String(row.errors)];
    } catch {
      out[row.source] = [String(row.errors)];
    }
  }
  return out;
}
