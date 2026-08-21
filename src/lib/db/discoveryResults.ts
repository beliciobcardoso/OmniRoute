/**
 * Database module: Discovery Results
 *
 * CRUD for the automated provider-discovery tool (opt-in, default off). Rows
 * live in the `discovery_results` table (migration 074). The Discovery service
 * (`src/lib/discovery/`) writes findings here via {@link upsertDiscoveryResult};
 * the `/api/discovery/*` routes read/verify/delete them.
 *
 * See `_tasks/features-v3.8.42/gaps/DISCOVERY_TOOL_DESIGN.md` for the design.
 */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export type DiscoveryMethod = "free_tier" | "web_cookie" | "auto_register" | "trial" | "public_api";
export type DiscoveryAuthType = "none" | "cookie" | "api_key" | "oauth";
export type DiscoveryRiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type DiscoveryStatus = "pending" | "testing" | "verified" | "rejected";

export interface DiscoveryResult {
  id?: number;
  providerId: string;
  method: DiscoveryMethod;
  endpoint?: string | null;
  authType: DiscoveryAuthType;
  models?: string[];
  rateLimit?: string | null;
  feasibility: number;
  riskLevel: DiscoveryRiskLevel;
  status: DiscoveryStatus;
  notes?: string | null;
  discoveredAt?: string;
  verifiedAt?: string | null;
}

interface DiscoveryRow {
  id: number;
  provider_id: string;
  method: string;
  endpoint: string | null;
  auth_type: string | null;
  models: string | null;
  rate_limit: string | null;
  feasibility: number | null;
  risk_level: string | null;
  status: string;
  notes: string | null;
  discovered_at: string;
  verified_at: string | null;
}

function rowToResult(row: DiscoveryRow): DiscoveryResult {
  let models: string[] | undefined;
  if (row.models) {
    try {
      const parsed = JSON.parse(row.models);
      if (Array.isArray(parsed)) models = parsed.map(String);
    } catch {
      models = undefined;
    }
  }
  return {
    id: Number(row.id),
    providerId: row.provider_id,
    method: row.method as DiscoveryMethod,
    endpoint: row.endpoint,
    authType: (row.auth_type as DiscoveryAuthType) ?? "none",
    models,
    rateLimit: row.rate_limit,
    feasibility:
      row.feasibility !== null && row.feasibility !== undefined ? Number(row.feasibility) : 0,
    riskLevel: (row.risk_level as DiscoveryRiskLevel) ?? "none",
    status: row.status as DiscoveryStatus,
    notes: row.notes,
    discoveredAt: row.discovered_at,
    verifiedAt: row.verified_at,
  };
}

/**
 * Insert or update a discovery finding. Uniqueness is keyed on
 * `(provider_id, method, endpoint)` (the table's UNIQUE constraint), so
 * re-discovering the same endpoint updates the existing row rather than
 * duplicating it. Returns the persisted row (with its id).
 */
export async function upsertDiscoveryResult(result: DiscoveryResult): Promise<DiscoveryResult> {
  const models = result.models ? JSON.stringify(result.models) : null;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const values = {
      provider_id: result.providerId,
      method: result.method,
      endpoint: result.endpoint ?? null,
      auth_type: result.authType,
      models,
      rate_limit: result.rateLimit ?? null,
      feasibility: result.feasibility,
      risk_level: result.riskLevel,
      status: result.status,
      notes: result.notes ?? null,
    };
    await kdb
      .insertInto("discovery_results")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["provider_id", "method", "endpoint"]).doUpdateSet({
          auth_type: values.auth_type,
          models: values.models,
          rate_limit: values.rate_limit,
          feasibility: values.feasibility,
          risk_level: values.risk_level,
          status: values.status,
          notes: values.notes,
        })
      )
      .execute();

    let query = kdb
      .selectFrom("discovery_results")
      .selectAll()
      .where("provider_id", "=", result.providerId)
      .where("method", "=", result.method);
    query =
      result.endpoint == null
        ? query.where("endpoint", "is", null)
        : query.where("endpoint", "=", result.endpoint);
    const row = await query.executeTakeFirst();
    // The row was just written, so it must exist.
    return rowToResult(row! as unknown as DiscoveryRow);
  }

  const db = getDbInstance();
  db.prepare(
    `INSERT INTO discovery_results
       (provider_id, method, endpoint, auth_type, models, rate_limit, feasibility, risk_level, status, notes)
     VALUES (@provider_id, @method, @endpoint, @auth_type, @models, @rate_limit, @feasibility, @risk_level, @status, @notes)
     ON CONFLICT(provider_id, method, endpoint) DO UPDATE SET
       auth_type = excluded.auth_type,
       models = excluded.models,
       rate_limit = excluded.rate_limit,
       feasibility = excluded.feasibility,
       risk_level = excluded.risk_level,
       status = excluded.status,
       notes = excluded.notes`
  ).run({
    provider_id: result.providerId,
    method: result.method,
    endpoint: result.endpoint ?? null,
    auth_type: result.authType,
    models,
    rate_limit: result.rateLimit ?? null,
    feasibility: result.feasibility,
    risk_level: result.riskLevel,
    status: result.status,
    notes: result.notes ?? null,
  });

  const row = db
    .prepare(
      `SELECT * FROM discovery_results
       WHERE provider_id = ? AND method = ? AND ifnull(endpoint, '') = ifnull(?, '')`
    )
    .get(result.providerId, result.method, result.endpoint ?? null) as DiscoveryRow | undefined;
  // The row was just written, so it must exist.
  return rowToResult(row!);
}

/**
 * List discovery results, optionally filtered to a single provider. Newest
 * findings first.
 */
export async function getDiscoveryResults(providerId?: string): Promise<DiscoveryResult[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().selectFrom("discovery_results").selectAll();
    if (providerId) query = query.where("provider_id", "=", providerId);
    const rows = await query.orderBy("discovered_at", "desc").orderBy("id", "desc").execute();
    return rows.map((r) => rowToResult(r as unknown as DiscoveryRow));
  }

  const db = getDbInstance();
  const rows = providerId
    ? (db
        .prepare(
          "SELECT * FROM discovery_results WHERE provider_id = ? ORDER BY discovered_at DESC, id DESC"
        )
        .all(providerId) as DiscoveryRow[])
    : (db
        .prepare("SELECT * FROM discovery_results ORDER BY discovered_at DESC, id DESC")
        .all() as DiscoveryRow[]);
  return rows.map(rowToResult);
}

export async function getDiscoveryResultById(id: number): Promise<DiscoveryResult | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("discovery_results")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToResult(row as unknown as DiscoveryRow) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM discovery_results WHERE id = ?").get(id) as
    DiscoveryRow | undefined;
  return row ? rowToResult(row) : null;
}

/**
 * Mark a finding as verified, stamping `verified_at`. Returns the updated row,
 * or null if no row with that id exists.
 */
export async function markVerified(id: number): Promise<DiscoveryResult | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .updateTable("discovery_results")
      .set({ status: "verified", verified_at: new Date().toISOString() })
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) return null;
    return getDiscoveryResultById(id);
  }

  const db = getDbInstance();
  const info = db
    .prepare(
      "UPDATE discovery_results SET status = 'verified', verified_at = datetime('now') WHERE id = ?"
    )
    .run(id);
  if (info.changes === 0) return null;
  return getDiscoveryResultById(id);
}

/**
 * Delete a finding. Returns true if a row was removed, false if the id was not
 * found.
 */
export async function deleteDiscoveryResult(id: number): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("discovery_results")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance();
  const info = db.prepare("DELETE FROM discovery_results WHERE id = ?").run(id);
  return info.changes > 0;
}
