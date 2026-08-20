import { randomUUID } from "crypto";
import { sql } from "kysely";
import { getDbInstance } from "./core";
import { backupDbFile } from "./backup";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

type JsonRecord = Record<string, unknown>;

export interface OneproxyProxyRecord {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  region: string | null;
  notes: string | null;
  status: string;
  source: string;
  qualityScore: number | null;
  latencyMs: number | null;
  anonymity: string | null;
  googleAccess: boolean;
  lastValidated: string | null;
  countryCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OneproxyStats {
  total: number;
  active: number;
  avgQuality: number | null;
  lastValidated: string | null;
  byProtocol: Array<{ protocol: string; count: number }>;
  byCountry: Array<{ countryCode: string; count: number }>;
}

interface OneproxyUpsertInput {
  ip: string;
  port: number;
  protocol: string;
  country?: string | null;
  countryCode?: string | null;
  anonymity?: string | null;
  qualityScore?: number | null;
  latencyMs?: number | null;
  googleAccess?: boolean;
  lastValidated?: string | null;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function mapProxyRow(row: unknown): OneproxyProxyRecord {
  const r = toRecord(row);
  return {
    id: typeof r.id === "string" ? r.id : "",
    name: typeof r.name === "string" ? r.name : "",
    type: typeof r.type === "string" ? r.type : "http",
    host: typeof r.host === "string" ? r.host : "",
    port: Number(r.port) || 0,
    region: typeof r.region === "string" ? r.region : null,
    notes: typeof r.notes === "string" ? r.notes : null,
    status: typeof r.status === "string" ? r.status : "active",
    source: typeof r.source === "string" ? r.source : "oneproxy",
    qualityScore:
      r.quality_score !== null && r.quality_score !== undefined ? Number(r.quality_score) : null,
    latencyMs: r.latency_ms !== null && r.latency_ms !== undefined ? Number(r.latency_ms) : null,
    anonymity: typeof r.anonymity === "string" ? r.anonymity : null,
    googleAccess: Number(r.google_access) === 1 || r.google_access === true,
    lastValidated: typeof r.last_validated === "string" ? r.last_validated : null,
    countryCode: typeof r.country_code === "string" ? r.country_code : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

function mapStatsRow(row: unknown) {
  const r = toRecord(row);
  return {
    total: Number(r.total) || 0,
    active: Number(r.active) || 0,
    avgQuality:
      r.avg_quality !== null && r.avg_quality !== undefined
        ? Math.round(Number(r.avg_quality) * 100) / 100
        : null,
    lastValidated: typeof r.last_validated === "string" ? r.last_validated : null,
  };
}

export async function listOneproxyProxies(options?: {
  protocol?: string;
  countryCode?: string;
  minQuality?: number;
  limit?: number;
}): Promise<OneproxyProxyRecord[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb()
      .selectFrom("proxy_registry")
      .selectAll()
      .where("source", "=", "oneproxy")
      .where("status", "=", "active");
    if (options?.protocol) query = query.where("type", "=", options.protocol);
    if (options?.countryCode) query = query.where("country_code", "=", options.countryCode);
    if (options?.minQuality != null) query = query.where("quality_score", ">=", options.minQuality);
    query = query.orderBy("quality_score", "desc").orderBy("last_validated", "desc");
    if (options?.limit) query = query.limit(options.limit);
    const rows = await query.execute();
    return rows.map(mapProxyRow);
  }

  const db = getDbInstance();

  let sql = "SELECT * FROM proxy_registry WHERE source = 'oneproxy' AND status = 'active'";
  const params: unknown[] = [];

  if (options?.protocol) {
    sql += " AND type = ?";
    params.push(options.protocol);
  }
  if (options?.countryCode) {
    sql += " AND country_code = ?";
    params.push(options.countryCode);
  }
  if (options?.minQuality != null) {
    sql += " AND quality_score >= ?";
    params.push(options.minQuality);
  }

  sql += " ORDER BY quality_score DESC, last_validated DESC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapProxyRow);
}

export async function getOneproxyStats(): Promise<OneproxyStats> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const statsRow = await kdb
      .selectFrom("proxy_registry")
      .select((eb) => [
        eb.fn.countAll().as("total"),
        eb.fn.sum(eb.case().when("status", "=", "active").then(1).else(0).end()).as("active"),
        eb.fn.avg("quality_score").as("avg_quality"),
        eb.fn.max("last_validated").as("last_validated"),
      ])
      .where("source", "=", "oneproxy")
      .executeTakeFirst();

    const stats = mapStatsRow(statsRow);

    const byProtocol = await kdb
      .selectFrom("proxy_registry")
      .select((eb) => ["type as protocol", eb.fn.countAll().as("count")])
      .where("source", "=", "oneproxy")
      .groupBy("type")
      .orderBy("count", "desc")
      .execute();

    const byCountry = await kdb
      .selectFrom("proxy_registry")
      .select((eb) => ["country_code as countryCode", eb.fn.countAll().as("count")])
      .where("source", "=", "oneproxy")
      .where("country_code", "is not", null)
      .groupBy("country_code")
      .orderBy("count", "desc")
      .limit(20)
      .execute();

    return {
      ...stats,
      byProtocol: byProtocol.map((r) => ({
        protocol: String((r as JsonRecord).protocol || "unknown"),
        count: Number((r as JsonRecord).count) || 0,
      })),
      byCountry: byCountry.map((r) => ({
        countryCode: String((r as JsonRecord).countryCode || "unknown"),
        count: Number((r as JsonRecord).count) || 0,
      })),
    };
  }

  const db = getDbInstance();

  const statsRow = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        AVG(quality_score) as avg_quality,
        MAX(last_validated) as last_validated
       FROM proxy_registry WHERE source = 'oneproxy'`
    )
    .get();

  const stats = mapStatsRow(statsRow);

  const byProtocol = db
    .prepare(
      "SELECT type as protocol, COUNT(*) as count FROM proxy_registry WHERE source = 'oneproxy' GROUP BY type ORDER BY count DESC"
    )
    .all() as Array<JsonRecord>;

  const byCountry = db
    .prepare(
      "SELECT country_code as countryCode, COUNT(*) as count FROM proxy_registry WHERE source = 'oneproxy' AND country_code IS NOT NULL GROUP BY country_code ORDER BY count DESC LIMIT 20"
    )
    .all() as Array<JsonRecord>;

  return {
    ...stats,
    byProtocol: byProtocol.map((r) => ({
      protocol: String(r.protocol || "unknown"),
      count: Number(r.count) || 0,
    })),
    byCountry: byCountry.map((r) => ({
      countryCode: String(r.countryCode || "unknown"),
      count: Number(r.count) || 0,
    })),
  };
}

export async function upsertOneproxyProxy(
  input: OneproxyUpsertInput
): Promise<{ proxy: OneproxyProxyRecord | null; action: "created" | "updated" }> {
  const now = new Date().toISOString();
  const name = `${input.protocol?.toUpperCase() || "HTTP"} - ${input.countryCode || "Unknown"} - ${input.ip}`;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const existingRow = await kdb
      .selectFrom("proxy_registry")
      .select("id")
      .where("host", "=", input.ip)
      .where("port", "=", input.port)
      .where("source", "=", "oneproxy")
      .executeTakeFirst();

    if (existingRow?.id) {
      await kdb
        .updateTable("proxy_registry")
        .set({
          status: "active",
          quality_score: input.qualityScore ?? null,
          latency_ms: input.latencyMs ?? null,
          anonymity: input.anonymity ?? null,
          google_access: input.googleAccess ? 1 : 0,
          last_validated: input.lastValidated ?? now,
          country_code: input.countryCode ?? null,
          updated_at: now,
        })
        .where("id", "=", existingRow.id)
        .execute();
      const proxy = await getOneproxyProxyById(existingRow.id);
      return { proxy, action: "updated" };
    }

    const id = randomUUID();
    await kdb
      .insertInto("proxy_registry")
      .values({
        id,
        name,
        type: input.protocol || "http",
        host: input.ip,
        port: input.port,
        region: input.countryCode ?? null,
        notes: null,
        status: "active",
        source: "oneproxy",
        quality_score: input.qualityScore ?? null,
        latency_ms: input.latencyMs ?? null,
        anonymity: input.anonymity ?? null,
        google_access: input.googleAccess ? 1 : 0,
        last_validated: input.lastValidated ?? now,
        country_code: input.countryCode ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const proxy = await getOneproxyProxyById(id);
    return { proxy, action: "created" };
  }

  const db = getDbInstance();

  const existing = db
    .prepare("SELECT id FROM proxy_registry WHERE host = ? AND port = ? AND source = 'oneproxy'")
    .get(input.ip, input.port) as { id?: string } | undefined;

  if (existing?.id) {
    db.prepare(
      `UPDATE proxy_registry
       SET status = ?, quality_score = ?, latency_ms = ?, anonymity = ?,
           google_access = ?, last_validated = ?, country_code = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      "active",
      input.qualityScore ?? null,
      input.latencyMs ?? null,
      input.anonymity ?? null,
      input.googleAccess ? 1 : 0,
      input.lastValidated ?? now,
      input.countryCode ?? null,
      now,
      existing.id
    );
    backupDbFile("pre-write");
    const proxy = await getOneproxyProxyById(existing.id);
    return { proxy, action: "updated" };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO proxy_registry
     (id, name, type, host, port, region, notes, status, source,
      quality_score, latency_ms, anonymity, google_access, last_validated, country_code,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    input.protocol || "http",
    input.ip,
    input.port,
    input.countryCode ?? null,
    null,
    "active",
    "oneproxy",
    input.qualityScore ?? null,
    input.latencyMs ?? null,
    input.anonymity ?? null,
    input.googleAccess ? 1 : 0,
    input.lastValidated ?? now,
    input.countryCode ?? null,
    now,
    now
  );
  backupDbFile("pre-write");
  const proxy = await getOneproxyProxyById(id);
  return { proxy, action: "created" };
}

export async function getOneproxyProxyById(id: string): Promise<OneproxyProxyRecord | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("proxy_registry")
      .selectAll()
      .where("id", "=", id)
      .where("source", "=", "oneproxy")
      .executeTakeFirst();
    if (!row) return null;
    return mapProxyRow(row);
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT * FROM proxy_registry WHERE id = ? AND source = 'oneproxy'")
    .get(id);
  if (!row) return null;
  return mapProxyRow(row);
}

export async function deleteOneproxyProxy(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("proxy_registry")
      .where("id", "=", id)
      .where("source", "=", "oneproxy")
      .executeTakeFirst();
    backupDbFile("pre-write");
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance();
  const result = db
    .prepare("DELETE FROM proxy_registry WHERE id = ? AND source = 'oneproxy'")
    .run(id);
  backupDbFile("pre-write");
  return result.changes > 0;
}

export async function clearAllOneproxyProxies(): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("proxy_registry")
      .where("source", "=", "oneproxy")
      .executeTakeFirst();
    backupDbFile("pre-write");
    return Number(result.numDeletedRows);
  }

  const db = getDbInstance();
  const result = db.prepare("DELETE FROM proxy_registry WHERE source = 'oneproxy'").run();
  backupDbFile("pre-write");
  return result.changes;
}

export async function getOneproxyProxyForRotation(options?: {
  strategy?: "random" | "quality" | "sequential";
}): Promise<OneproxyProxyRecord | null> {
  const strategy = options?.strategy || "quality";

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb()
      .selectFrom("proxy_registry")
      .selectAll()
      .where("source", "=", "oneproxy")
      .where("status", "=", "active");

    switch (strategy) {
      case "quality":
        query = query.orderBy("quality_score", "desc").orderBy("latency_ms", "asc");
        break;
      case "random":
        query = query.orderBy(sql`RANDOM()`);
        break;
      case "sequential":
        query = query.orderBy("last_validated", "asc");
        break;
    }

    const row = await query.limit(1).executeTakeFirst();
    if (!row) return null;
    return mapProxyRow(row);
  }

  const db = getDbInstance();

  let sqlStr = "SELECT * FROM proxy_registry WHERE source = 'oneproxy' AND status = 'active'";

  switch (strategy) {
    case "quality":
      sqlStr += " ORDER BY quality_score DESC, latency_ms ASC LIMIT 1";
      break;
    case "random":
      sqlStr += " ORDER BY RANDOM() LIMIT 1";
      break;
    case "sequential":
      sqlStr += " ORDER BY last_validated ASC LIMIT 1";
      break;
  }

  const row = db.prepare(sqlStr).get();
  if (!row) return null;
  return mapProxyRow(row);
}

export async function markOneproxyProxyFailed(host: string, port: number): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const existing = await kdb
      .selectFrom("proxy_registry")
      .select("quality_score")
      .where("host", "=", host)
      .where("port", "=", port)
      .where("source", "=", "oneproxy")
      .executeTakeFirst();
    if (!existing) return false;

    const currentQuality = existing.quality_score !== null ? Number(existing.quality_score) : 50;
    const newQuality = Math.max(0, currentQuality - 10);
    const patch: Record<string, unknown> = {
      quality_score: newQuality,
      updated_at: new Date().toISOString(),
    };
    // Matches the SQLite CASE clause: the inactivation threshold is checked
    // against the pre-decrement quality score, not the post-decrement one.
    if (currentQuality <= 10) patch.status = "inactive";

    const result = await kdb
      .updateTable("proxy_registry")
      .set(patch)
      .where("host", "=", host)
      .where("port", "=", port)
      .where("source", "=", "oneproxy")
      .executeTakeFirst();
    backupDbFile("pre-write");
    return Number(result.numUpdatedRows) > 0;
  }

  const db = getDbInstance();
  const result = db
    .prepare(
      `UPDATE proxy_registry
       SET quality_score = MAX(0, COALESCE(quality_score, 50) - 10),
           status = CASE WHEN COALESCE(quality_score, 50) <= 10 THEN 'inactive' ELSE status END,
           updated_at = datetime('now')
       WHERE host = ? AND port = ? AND source = 'oneproxy'`
    )
    .run(host, port);
  backupDbFile("pre-write");
  return result.changes > 0;
}
