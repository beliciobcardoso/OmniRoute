/**
 * Middleware Hooks DB — CRUD operations for middleware_hooks table
 *
 * Module: src/lib/db/middleware.ts
 * Table: middleware_hooks
 * Logs:  middleware_logs
 */

import { getDbInstance } from "@/lib/db/core";
import type { HookConfig, HookConfigRow, HookLogEntry, HookScope } from "@/lib/middleware/types";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// ── Helpers ──────────────────────────────────────────────────────────

function rowToHookConfig(row: HookConfigRow): HookConfig {
  return {
    name: row.name,
    description: row.description,
    priority: Number(row.priority),
    scope:
      row.scope_type === "combo" && row.combo_id
        ? { type: "combo", comboId: row.combo_id }
        : { type: "global" },
    enabled: Number(row.enabled) === 1,
    code: row.code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runCount: Number(row.run_count),
    lastError: row.last_error || undefined,
  };
}

function hookConfigToRow(config: HookConfig): HookConfigRow {
  return {
    name: config.name,
    description: config.description,
    priority: config.priority,
    scope_type: config.scope.type,
    combo_id: config.scope.type === "combo" ? config.scope.comboId : null,
    enabled: config.enabled ? 1 : 0,
    code: config.code,
    created_at: config.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_count: config.runCount || 0,
    last_error: config.lastError,
  };
}

// ── CRUD Operations ─────────────────────────────────────────────────

/**
 * Get all hooks from DB.
 */
export async function getAllMiddlewareHooks(): Promise<HookConfig[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("middleware_hooks")
      .selectAll()
      .orderBy("priority", "asc")
      .orderBy("name", "asc")
      .execute();
    return rows.map((r) => rowToHookConfig(r as unknown as HookConfigRow));
  }

  const db = getDbInstance() as any;
  const rows = db
    .prepare("SELECT * FROM middleware_hooks ORDER BY priority ASC, name ASC")
    .all() as HookConfigRow[];
  return rows.map(rowToHookConfig);
}

/**
 * Get enabled hooks from DB (for runtime loading).
 */
export async function getEnabledMiddlewareHooks(): Promise<HookConfig[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("middleware_hooks")
      .selectAll()
      .where("enabled", "=", 1)
      .orderBy("priority", "asc")
      .execute();
    return rows.map((r) => rowToHookConfig(r as unknown as HookConfigRow));
  }

  const db = getDbInstance() as any;
  const rows = db
    .prepare("SELECT * FROM middleware_hooks WHERE enabled = 1 ORDER BY priority ASC")
    .all() as HookConfigRow[];
  return rows.map(rowToHookConfig);
}

/**
 * Get scoped hooks for a given combo ID.
 */
export async function getComboMiddlewareHooks(comboId: string): Promise<HookConfig[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("middleware_hooks")
      .selectAll()
      .where("enabled", "=", 1)
      .where((eb) =>
        eb.or([
          eb("scope_type", "=", "global"),
          eb.and([eb("scope_type", "=", "combo"), eb("combo_id", "=", comboId)]),
        ])
      )
      .orderBy("priority", "asc")
      .execute();
    return rows.map((r) => rowToHookConfig(r as unknown as HookConfigRow));
  }

  const db = getDbInstance() as any;
  const rows = db
    .prepare(
      "SELECT * FROM middleware_hooks WHERE enabled = 1 AND (scope_type = 'global' OR (scope_type = 'combo' AND combo_id = ?)) ORDER BY priority ASC"
    )
    .all(comboId) as HookConfigRow[];
  return rows.map(rowToHookConfig);
}

/**
 * Get a single hook by name.
 */
export async function getMiddlewareHook(name: string): Promise<HookConfig | undefined> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("middleware_hooks")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();
    return row ? rowToHookConfig(row as unknown as HookConfigRow) : undefined;
  }

  const db = getDbInstance() as any;
  const row = db.prepare("SELECT * FROM middleware_hooks WHERE name = ?").get(name) as
    HookConfigRow | undefined;
  return row ? rowToHookConfig(row) : undefined;
}

/**
 * Create a new middleware hook.
 */
export async function createMiddlewareHook(config: HookConfig): Promise<HookConfig> {
  const row = hookConfigToRow(config);
  row.created_at = new Date().toISOString();
  row.updated_at = row.created_at;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("middleware_hooks")
      .values({
        name: row.name,
        description: row.description,
        priority: row.priority,
        scope_type: row.scope_type,
        combo_id: row.combo_id ?? null,
        enabled: row.enabled,
        code: row.code,
        created_at: row.created_at,
        updated_at: row.updated_at,
        run_count: row.run_count,
        last_error: row.last_error ?? null,
      })
      .execute();
    return (await getMiddlewareHook(config.name))!;
  }

  const db = getDbInstance() as any;
  db.prepare(
    `
    INSERT INTO middleware_hooks (name, description, priority, scope_type, combo_id, enabled, code, created_at, updated_at, run_count, last_error)
    VALUES (@name, @description, @priority, @scope_type, @combo_id, @enabled, @code, @created_at, @updated_at, @run_count, @last_error)
  `
  ).run(row);

  return (await getMiddlewareHook(config.name))!;
}

/**
 * Update an existing middleware hook.
 */
export async function updateMiddlewareHook(
  name: string,
  updates: Partial<HookConfig>
): Promise<HookConfig | undefined> {
  const existing = await getMiddlewareHook(name);
  if (!existing) return undefined;

  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  const row = hookConfigToRow(updated);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("middleware_hooks")
      .set({
        description: row.description,
        priority: row.priority,
        scope_type: row.scope_type,
        combo_id: row.combo_id ?? null,
        enabled: row.enabled,
        code: row.code,
        updated_at: row.updated_at,
        run_count: row.run_count,
        last_error: row.last_error ?? null,
      })
      .where("name", "=", row.name)
      .execute();
    return getMiddlewareHook(name);
  }

  const db = getDbInstance() as any;
  db.prepare(
    `
    UPDATE middleware_hooks SET
      description = @description,
      priority = @priority,
      scope_type = @scope_type,
      combo_id = @combo_id,
      enabled = @enabled,
      code = @code,
      updated_at = @updated_at,
      run_count = @run_count,
      last_error = @last_error
    WHERE name = @name
  `
  ).run(row);

  return getMiddlewareHook(name);
}

/**
 * Delete a middleware hook.
 */
export async function deleteMiddlewareHook(name: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("middleware_hooks")
      .where("name", "=", name)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance() as any;
  const result = db.prepare("DELETE FROM middleware_hooks WHERE name = ?").run(name);
  return result.changes > 0;
}

/**
 * Increment run count and optionally update last error.
 */
export async function recordHookExecution(name: string, error?: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("middleware_hooks")
      .set((eb) => ({
        run_count: eb("run_count", "+", 1),
        last_error: error ?? null,
        updated_at: new Date().toISOString(),
      }))
      .where("name", "=", name)
      .execute();
    return;
  }

  const db = getDbInstance() as any;
  if (error) {
    db.prepare(
      "UPDATE middleware_hooks SET run_count = run_count + 1, last_error = ?, updated_at = datetime('now') WHERE name = ?"
    ).run(error, name);
  } else {
    db.prepare(
      "UPDATE middleware_hooks SET run_count = run_count + 1, last_error = NULL, updated_at = datetime('now') WHERE name = ?"
    ).run(name);
  }
}

// ── Log Operations ──────────────────────────────────────────────────

/**
 * Insert a hook execution log entry.
 */
export async function insertHookLog(entry: HookLogEntry): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("middleware_logs")
      .values({
        id: entry.id,
        hook_name: entry.hookName,
        request_id: entry.requestId,
        duration_ms: entry.durationMs,
        mutated: entry.mutated ? 1 : 0,
        skipped: entry.skipped ? 1 : 0,
        error: entry.error || null,
        timestamp: entry.timestamp,
      })
      .execute();
    return;
  }

  const db = getDbInstance() as any;
  db.prepare(
    `
    INSERT INTO middleware_logs (id, hook_name, request_id, duration_ms, mutated, skipped, error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    entry.id,
    entry.hookName,
    entry.requestId,
    entry.durationMs,
    entry.mutated ? 1 : 0,
    entry.skipped ? 1 : 0,
    entry.error || null,
    entry.timestamp
  );
}

/**
 * Get hook execution logs, optionally filtered by hook name.
 */
export async function getHookLogs(hookName?: string, limit = 50): Promise<HookLogEntry[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    let query = getKyselyDb().selectFrom("middleware_logs").selectAll();
    if (hookName) {
      query = query.where("hook_name", "=", hookName);
    }
    const rows = await query.orderBy("timestamp", "desc").limit(limit).execute();
    return rows.map((r) => ({
      id: r.id,
      hookName: r.hook_name,
      requestId: r.request_id,
      durationMs: Number(r.duration_ms),
      mutated: Number(r.mutated) === 1,
      skipped: Number(r.skipped) === 1,
      error: r.error ?? undefined,
      timestamp: r.timestamp,
    }));
  }

  const db = getDbInstance() as any;
  let rows: any[];
  if (hookName) {
    rows = db
      .prepare("SELECT * FROM middleware_logs WHERE hook_name = ? ORDER BY timestamp DESC LIMIT ?")
      .all(hookName, limit);
  } else {
    rows = db.prepare("SELECT * FROM middleware_logs ORDER BY timestamp DESC LIMIT ?").all(limit);
  }
  return rows.map((r: any) => ({
    id: r.id,
    hookName: r.hook_name,
    requestId: r.request_id,
    durationMs: r.duration_ms,
    mutated: r.mutated === 1,
    skipped: r.skipped === 1,
    error: r.error,
    timestamp: r.timestamp,
  }));
}

/**
 * Clean up old hook logs (keep last N entries).
 */
export async function cleanupHookLogs(maxEntries = 10000): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const db = getKyselyDb();
    const result = await db
      .deleteFrom("middleware_logs")
      .where(
        "id",
        "not in",
        db.selectFrom("middleware_logs").select("id").orderBy("timestamp", "desc").limit(maxEntries)
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  const db = getDbInstance() as any;
  // Delete logs beyond the max, keeping the most recent
  const result = db
    .prepare(
      `
    DELETE FROM middleware_logs WHERE id NOT IN (
      SELECT id FROM middleware_logs ORDER BY timestamp DESC LIMIT ?
    )
  `
    )
    .run(maxEntries);
  return result.changes;
}
