/**
 * Relay Proxy DB module
 *
 * Manages relay tokens, rate limits, and usage tracking for serverless relay proxies.
 */

import { createHash, randomBytes } from "node:crypto";
import { getDbInstance } from "./core";
import { rowToCamel } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

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

function toBool(value: unknown): boolean {
  return toInt(value) === 1;
}

// Postgres BIGINT columns come back as JS strings; coerce the numeric fields
// before returning to callers, matching existing SQLite behavior exactly.
function normalizeRelayToken(token: RelayToken): RelayToken {
  return {
    ...token,
    maxTokensPerRequest: toInt(token.maxTokensPerRequest),
    maxRequestsPerMinute: toInt(token.maxRequestsPerMinute),
    maxRequestsPerDay: toInt(token.maxRequestsPerDay),
    createdAt: toInt(token.createdAt),
    updatedAt: toInt(token.updatedAt),
    expiresAt: toIntOrNull(token.expiresAt),
    lastUsedAt: toIntOrNull(token.lastUsedAt),
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface RelayToken {
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  description: string;
  comboId: string | null;
  allowedModels: string;
  maxTokensPerRequest: number;
  maxRequestsPerMinute: number;
  maxRequestsPerDay: number;
  maxCostPerDay: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  metadata: string;
}

export interface RelayTokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  description: string;
  combo_id: string | null;
  allowed_models: string;
  max_tokens_per_request: number;
  max_requests_per_minute: number;
  max_requests_per_day: number;
  max_cost_per_day: number;
  enabled: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  metadata: string;
}

export interface CreateRelayTokenInput {
  name: string;
  description?: string;
  comboId?: string;
  allowedModels?: string[];
  maxTokensPerRequest?: number;
  maxRequestsPerMinute?: number;
  maxRequestsPerDay?: number;
  maxCostPerDay?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface RelayTokenWithSecret extends RelayToken {
  rawToken: string; // Only returned once on creation
}

export interface RelayLogRow {
  id: number;
  token_id: string;
  request_id: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  status: string;
  status_code: number;
  latency_ms: number;
  client_ip: string | null;
  user_agent: string | null;
  created_at: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return "rl_" + randomBytes(16).toString("hex");
}

function generateToken(): string {
  return "relay_" + randomBytes(24).toString("hex");
}

function hashToken(token: string): string {
  // Simple hash for token comparison (not bcrypt-heavy for performance)
  return createHash("sha256").update(token).digest("hex");
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function createRelayToken(
  input: CreateRelayTokenInput
): Promise<RelayTokenWithSecret> {
  const id = generateId();
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const prefix = "rl_" + rawToken.slice(6, 14);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("relay_tokens")
      .values({
        id,
        name: input.name,
        token_hash: tokenHash,
        token_prefix: prefix,
        description: input.description || "",
        combo_id: input.comboId || null,
        allowed_models: JSON.stringify(input.allowedModels || ["*"]),
        max_tokens_per_request: input.maxTokensPerRequest || 128000,
        max_requests_per_minute: input.maxRequestsPerMinute || 60,
        max_requests_per_day: input.maxRequestsPerDay || 10000,
        max_cost_per_day: input.maxCostPerDay || 0,
        enabled: 1,
        created_at: now,
        updated_at: now,
        expires_at: input.expiresAt || null,
        metadata: JSON.stringify(input.metadata || {}),
      })
      .execute();

    const token = await kdb
      .selectFrom("relay_tokens")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return {
      ...normalizeRelayToken({
        ...(rowToCamel(token) as unknown as RelayToken),
        enabled: toBool(token.enabled),
      }),
      rawToken,
    };
  }

  const db = getDbInstance();
  db.prepare(
    `
    INSERT INTO relay_tokens (id, name, token_hash, token_prefix, description, combo_id, allowed_models,
      max_tokens_per_request, max_requests_per_minute, max_requests_per_day, max_cost_per_day,
      enabled, created_at, updated_at, expires_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `
  ).run(
    id,
    input.name,
    tokenHash,
    prefix,
    input.description || "",
    input.comboId || null,
    JSON.stringify(input.allowedModels || ["*"]),
    input.maxTokensPerRequest || 128000,
    input.maxRequestsPerMinute || 60,
    input.maxRequestsPerDay || 10000,
    input.maxCostPerDay || 0,
    now,
    now,
    input.expiresAt || null,
    JSON.stringify(input.metadata || {})
  );

  const token = db.prepare("SELECT * FROM relay_tokens WHERE id = ?").get(id) as RelayTokenRow;
  return { ...(rowToCamel(token) as unknown as RelayToken), rawToken };
}

export async function getRelayTokens(): Promise<RelayToken[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("relay_tokens")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((r) =>
      normalizeRelayToken({
        ...(rowToCamel(r) as unknown as RelayToken),
        enabled: toBool(r.enabled),
      })
    );
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM relay_tokens ORDER BY created_at DESC")
    .all() as RelayTokenRow[];
  return rows.map((r) => ({
    ...(rowToCamel(r) as unknown as RelayToken),
    enabled: r.enabled === 1,
  }));
}

export async function getRelayToken(id: string): Promise<RelayToken | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("relay_tokens")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return normalizeRelayToken({
      ...(rowToCamel(row) as unknown as RelayToken),
      enabled: toBool(row.enabled),
    });
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM relay_tokens WHERE id = ?").get(id) as
    RelayTokenRow | undefined;
  if (!row) return null;
  return { ...(rowToCamel(row) as unknown as RelayToken), enabled: row.enabled === 1 };
}

export async function getRelayTokenByHash(
  tokenHash: string
): Promise<(RelayToken & { rawToken?: string }) | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("relay_tokens")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .where("enabled", "=", 1)
      .executeTakeFirst();
    if (!row) return null;
    return normalizeRelayToken({
      ...(rowToCamel(row) as unknown as RelayToken),
      enabled: toBool(row.enabled),
    });
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT * FROM relay_tokens WHERE token_hash = ? AND enabled = 1")
    .get(tokenHash) as RelayTokenRow | undefined;
  if (!row) return null;
  return { ...(rowToCamel(row) as unknown as RelayToken), enabled: row.enabled === 1 };
}

export async function updateRelayToken(
  id: string,
  updates: Partial<CreateRelayTokenInput>
): Promise<RelayToken | null> {
  const now = Math.floor(Date.now() / 1000);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const set: Record<string, unknown> = { updated_at: now };
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.description !== undefined) set.description = updates.description;
    if (updates.comboId !== undefined) set.combo_id = updates.comboId;
    if (updates.allowedModels !== undefined) {
      set.allowed_models = JSON.stringify(updates.allowedModels);
    }
    if (updates.maxTokensPerRequest !== undefined) {
      set.max_tokens_per_request = updates.maxTokensPerRequest;
    }
    if (updates.maxRequestsPerMinute !== undefined) {
      set.max_requests_per_minute = updates.maxRequestsPerMinute;
    }
    if (updates.maxRequestsPerDay !== undefined) {
      set.max_requests_per_day = updates.maxRequestsPerDay;
    }
    if (updates.maxCostPerDay !== undefined) set.max_cost_per_day = updates.maxCostPerDay;

    await getKyselyDb()
      .updateTable("relay_tokens")
      .set(set as any)
      .where("id", "=", id)
      .execute();
    return getRelayToken(id);
  }

  const db = getDbInstance();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (updates.name !== undefined) {
    sets.push("name = ?");
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }
  if (updates.comboId !== undefined) {
    sets.push("combo_id = ?");
    params.push(updates.comboId);
  }
  if (updates.allowedModels !== undefined) {
    sets.push("allowed_models = ?");
    params.push(JSON.stringify(updates.allowedModels));
  }
  if (updates.maxTokensPerRequest !== undefined) {
    sets.push("max_tokens_per_request = ?");
    params.push(updates.maxTokensPerRequest);
  }
  if (updates.maxRequestsPerMinute !== undefined) {
    sets.push("max_requests_per_minute = ?");
    params.push(updates.maxRequestsPerMinute);
  }
  if (updates.maxRequestsPerDay !== undefined) {
    sets.push("max_requests_per_day = ?");
    params.push(updates.maxRequestsPerDay);
  }
  if (updates.maxCostPerDay !== undefined) {
    sets.push("max_cost_per_day = ?");
    params.push(updates.maxCostPerDay);
  }

  params.push(id);
  db.prepare(`UPDATE relay_tokens SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getRelayToken(id);
}

export async function deleteRelayToken(id: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb().deleteFrom("relay_tokens").where("id", "=", id).execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM relay_tokens WHERE id = ?").run(id);
}

export async function toggleRelayToken(id: string, enabled: boolean): Promise<RelayToken | null> {
  const now = Math.floor(Date.now() / 1000);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("relay_tokens")
      .set({ enabled: enabled ? 1 : 0, updated_at: now })
      .where("id", "=", id)
      .execute();
    return getRelayToken(id);
  }

  const db = getDbInstance();
  db.prepare("UPDATE relay_tokens SET enabled = ?, updated_at = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    now,
    id
  );
  return getRelayToken(id);
}

// ── Usage / Rate Limit ───────────────────────────────────────────────────────

export async function checkRateLimit(
  tokenId: string,
  existingToken?: RelayToken
): Promise<{
  allowed: boolean;
  remaining: number;
  resetIn: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const minuteWindow = Math.floor(now / 60) * 60;
  const dayWindow = Math.floor(now / 86400) * 86400;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    let token = existingToken;
    if (!token) {
      const fetched = await getRelayToken(tokenId);
      if (!fetched) return { allowed: false, remaining: 0, resetIn: 0 };
      token = fetched;
    }

    const minuteRow = await kdb
      .selectFrom("relay_rate_limits")
      .select(["request_count", "cost"])
      .where("token_id", "=", tokenId)
      .where("window_start", "=", minuteWindow)
      .executeTakeFirst();
    const minuteCount = toInt(minuteRow?.request_count);
    if (minuteCount >= token.maxRequestsPerMinute) {
      return { allowed: false, remaining: 0, resetIn: 60 - (now % 60) };
    }

    const dayRow = await kdb
      .selectFrom("relay_rate_limits")
      .select((eb) => eb.fn.sum("request_count").as("total"))
      .where("token_id", "=", tokenId)
      .where("window_start", ">=", dayWindow)
      .executeTakeFirst();
    const dayCount = toInt(dayRow?.total);
    if (dayCount >= token.maxRequestsPerDay) {
      return { allowed: false, remaining: 0, resetIn: 86400 - (now % 86400) };
    }

    const remaining = Math.min(
      token.maxRequestsPerMinute - minuteCount,
      token.maxRequestsPerDay - dayCount
    );
    return { allowed: true, remaining, resetIn: 60 - (now % 60) };
  }

  const db = getDbInstance();
  let token = existingToken;
  if (!token) {
    const row = db.prepare("SELECT * FROM relay_tokens WHERE id = ?").get(tokenId) as
      RelayTokenRow | undefined;
    if (!row) return { allowed: false, remaining: 0, resetIn: 0 };
    token = rowToCamel(row) as unknown as RelayToken;
  }

  // Check minute rate
  const minuteRow = db
    .prepare(
      "SELECT request_count, cost FROM relay_rate_limits WHERE token_id = ? AND window_start = ?"
    )
    .get(tokenId, minuteWindow) as { request_count: number; cost: number } | undefined;

  const minuteCount = minuteRow?.request_count || 0;
  if (minuteCount >= token.maxRequestsPerMinute) {
    return { allowed: false, remaining: 0, resetIn: 60 - (now % 60) };
  }

  // Check daily rate
  const dayRow = db
    .prepare(
      "SELECT SUM(request_count) as total FROM relay_rate_limits WHERE token_id = ? AND window_start >= ?"
    )
    .get(tokenId, dayWindow) as { total: number } | undefined;

  const dayCount = dayRow?.total || 0;
  if (dayCount >= token.maxRequestsPerDay) {
    return { allowed: false, remaining: 0, resetIn: 86400 - (now % 86400) };
  }

  const remaining = Math.min(
    token.maxRequestsPerMinute - minuteCount,
    token.maxRequestsPerDay - dayCount
  );

  return { allowed: true, remaining, resetIn: 60 - (now % 60) };
}

export async function recordRelayUsage(
  tokenId: string,
  params: {
    requestId?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    cost?: number;
    status?: string;
    statusCode?: number;
    latencyMs?: number;
    clientIp?: string;
    userAgent?: string;
  }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const minuteWindow = Math.floor(now / 60) * 60;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();

    await kdb
      .insertInto("relay_rate_limits")
      .values({
        token_id: tokenId,
        window_start: minuteWindow,
        request_count: 1,
        cost: params.cost || 0,
      })
      .onConflict((oc) =>
        oc.columns(["token_id", "window_start"]).doUpdateSet((eb) => ({
          request_count: eb("relay_rate_limits.request_count", "+", 1),
          cost: eb("relay_rate_limits.cost", "+", params.cost || 0),
        }))
      )
      .execute();

    await kdb
      .updateTable("relay_tokens")
      .set({ last_used_at: now })
      .where("id", "=", tokenId)
      .execute();

    await kdb
      .insertInto("relay_logs")
      .values({
        token_id: tokenId,
        request_id: params.requestId || null,
        model: params.model || null,
        prompt_tokens: params.promptTokens || 0,
        completion_tokens: params.completionTokens || 0,
        cost: params.cost || 0,
        status: params.status || "success",
        status_code: params.statusCode || 200,
        latency_ms: params.latencyMs || 0,
        client_ip: params.clientIp || null,
        user_agent: params.userAgent || null,
        created_at: now,
      })
      .execute();
    return;
  }

  const db = getDbInstance();

  // Update rate limit window
  db.prepare(
    `
    INSERT INTO relay_rate_limits (token_id, window_start, request_count, cost)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(token_id, window_start) DO UPDATE SET
      request_count = request_count + 1,
      cost = cost + ?
  `
  ).run(tokenId, minuteWindow, params.cost || 0, params.cost || 0);

  // Update last_used_at
  db.prepare("UPDATE relay_tokens SET last_used_at = ? WHERE id = ?").run(now, tokenId);

  // Insert log
  db.prepare(
    `
    INSERT INTO relay_logs (token_id, request_id, model, prompt_tokens, completion_tokens, cost,
      status, status_code, latency_ms, client_ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    tokenId,
    params.requestId || null,
    params.model || null,
    params.promptTokens || 0,
    params.completionTokens || 0,
    params.cost || 0,
    params.status || "success",
    params.statusCode || 200,
    params.latencyMs || 0,
    params.clientIp || null,
    params.userAgent || null,
    now
  );
}

export async function getRelayUsage(
  tokenId: string,
  since: number
): Promise<{ requestCount: number; totalCost: number }> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("relay_logs")
      .select((eb) => [
        eb.fn.countAll().as("request_count"),
        eb.fn.coalesce(eb.fn.sum("cost"), eb.lit(0)).as("total_cost"),
      ])
      .where("token_id", "=", tokenId)
      .where("created_at", ">=", since)
      .executeTakeFirstOrThrow();
    return { requestCount: toInt(row.request_count), totalCost: Number(row.total_cost) || 0 };
  }

  const db = getDbInstance();
  const row = db
    .prepare(
      "SELECT COUNT(*) as request_count, COALESCE(SUM(cost), 0) as total_cost FROM relay_logs WHERE token_id = ? AND created_at >= ?"
    )
    .get(tokenId, since) as { request_count: number; total_cost: number };
  return { requestCount: row.request_count, totalCost: row.total_cost };
}

export async function getRelayLogs(tokenId?: string, limit = 50): Promise<RelayLogRow[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().selectFrom("relay_logs").selectAll();
    if (tokenId) query = query.where("token_id", "=", tokenId);
    const rows = await query.orderBy("created_at", "desc").limit(limit).execute();
    return rows as unknown as RelayLogRow[];
  }

  const db = getDbInstance();
  if (tokenId) {
    return db
      .prepare("SELECT * FROM relay_logs WHERE token_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(tokenId, limit) as RelayLogRow[];
  }
  return db
    .prepare("SELECT * FROM relay_logs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as RelayLogRow[];
}
