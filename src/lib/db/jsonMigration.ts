/**
 * db/jsonMigration.ts — Shared helper to hydrate a database from a
 * legacy OmniRoute JSON backup object.
 *
 * Used by:
 *  - api/settings/import-json/route.ts  (on-demand import via dashboard)
 *
 * 🔒 Security: the caller is responsible for stripping sensitive keys
 * (password, requireLogin) from `data.settings` BEFORE passing the object
 * here, so this function never touches authentication configuration.
 */

import { sql, type Kysely, type Transaction } from "kysely";
import type { SqliteAdapter } from "./adapters/types";
import type { SqliteBoolean, Database } from "./kysely/types";
import { normalizeRoutingStrategy } from "@/shared/constants/routingStrategies";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

type SqliteDatabase = SqliteAdapter;
type KyselyOrTrx = Kysely<Database> | Transaction<Database>;

export interface LegacyJsonData {
  providerConnections?: Record<string, unknown>[];
  providerNodes?: Record<string, unknown>[];
  combos?: Record<string, unknown>[];
  apiKeys?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
  modelAliases?: Record<string, unknown>;
  mitmAlias?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  customModels?: Record<string, unknown>;
  proxyConfig?: {
    global?: unknown;
    providers?: Record<string, unknown>;
    combos?: Record<string, unknown>;
    keys?: Record<string, unknown>;
  };
  usageHistory?: Record<string, any>[];
  domainCostHistory?: Record<string, any>[];
  domainBudgets?: Record<string, any>[];
}

interface MigrationCounts {
  connections: number;
  nodes: number;
  combos: number;
  apiKeys: number;
  usageHistory: number;
  domainCostHistory: number;
  domainBudgets: number;
}

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function normalizeCombo(combo: Record<string, unknown>, index: number) {
  const config =
    combo.config && typeof combo.config === "object" && !Array.isArray(combo.config)
      ? { ...(combo.config as Record<string, unknown>) }
      : combo.config;
  if (config && typeof config === "object" && !Array.isArray(config) && "strategy" in config) {
    (config as Record<string, unknown>).strategy = normalizeRoutingStrategy(
      (config as Record<string, unknown>).strategy
    );
  }
  const normalizedCombo: Record<string, unknown> = {
    ...combo,
    strategy: normalizeRoutingStrategy(combo.strategy),
    config,
    sortOrder: typeof combo.sortOrder === "number" ? combo.sortOrder : index + 1,
  };
  return normalizedCombo;
}

async function migratePg(data: LegacyJsonData): Promise<MigrationCounts> {
  await ensurePostgresBootstrap();
  const kdb = getKyselyDb();

  await kdb.transaction().execute(async (trx: KyselyOrTrx) => {
    // 1. Provider Connections
    for (const conn of data.providerConnections ?? []) {
      const values = {
        id: conn.id as string,
        provider: conn.provider as string,
        auth_type: (conn.authType as string) ?? "oauth",
        name: (conn.name as string) ?? null,
        email: (conn.email as string) ?? null,
        priority: (conn.priority as number) ?? 0,
        is_active: conn.isActive !== false,
        access_token: (conn.accessToken as string) ?? null,
        refresh_token: (conn.refreshToken as string) ?? null,
        expires_at: (conn.expiresAt as string) ?? null,
        token_expires_at: (conn.tokenExpiresAt as string) ?? null,
        scope: (conn.scope as string) ?? null,
        project_id: (conn.projectId as string) ?? null,
        test_status: (conn.testStatus as string) ?? null,
        error_code: (conn.errorCode as string) ?? null,
        last_error: (conn.lastError as string) ?? null,
        last_error_at: (conn.lastErrorAt as string) ?? null,
        last_error_type: (conn.lastErrorType as string) ?? null,
        last_error_source: (conn.lastErrorSource as string) ?? null,
        backoff_level: (conn.backoffLevel as number) ?? 0,
        rate_limited_until: (conn.rateLimitedUntil as string) ?? null,
        health_check_interval: (conn.healthCheckInterval as number) ?? null,
        last_health_check_at: (conn.lastHealthCheckAt as string) ?? null,
        last_tested: (conn.lastTested as string) ?? null,
        api_key: (conn.apiKey as string) ?? null,
        id_token: (conn.idToken as string) ?? null,
        provider_specific_data: (conn.providerSpecificData as string) ?? null,
        expires_in: (conn.expiresIn as number) ?? null,
        display_name: (conn.displayName as string) ?? null,
        global_priority: (conn.globalPriority as number) ?? null,
        default_model: (conn.defaultModel as string) ?? null,
        token_type: (conn.tokenType as string) ?? null,
        consecutive_use_count: (conn.consecutiveUseCount as number) ?? 0,
        rate_limit_protection: conn.rateLimitProtection === true || conn.rateLimitProtection === 1,
        last_used_at: (conn.lastUsedAt as string) ?? null,
        created_at: (conn.createdAt as string) ?? new Date().toISOString(),
        updated_at: (conn.updatedAt as string) ?? new Date().toISOString(),
      };
      const { id, ...updateValues } = values;
      await trx
        .insertInto("provider_connections")
        .values({
          ...values,
          is_active: values.is_active as unknown as SqliteBoolean,
          rate_limit_protection: values.rate_limit_protection as unknown as SqliteBoolean,
        })
        .onConflict((oc) => oc.column("id").doUpdateSet(updateValues))
        .execute();
    }

    // 2. Provider Nodes
    for (const node of data.providerNodes ?? []) {
      const values = {
        id: node.id as string,
        type: node.type as string,
        name: node.name as string,
        prefix: (node.prefix as string) ?? null,
        api_type: (node.apiType as string) ?? null,
        base_url: (node.baseUrl as string) ?? null,
        created_at: (node.createdAt as string) ?? new Date().toISOString(),
        updated_at: (node.updatedAt as string) ?? new Date().toISOString(),
      };
      const { id, ...updateValues } = values;
      await trx
        .insertInto("provider_nodes")
        .values(values)
        .onConflict((oc) => oc.column("id").doUpdateSet(updateValues))
        .execute();
    }

    // 3. Key-Value Settings (caller must have stripped password / requireLogin)
    for (const [key, value] of Object.entries(data.settings ?? {})) {
      await trx
        .insertInto("key_value")
        .values({ namespace: "settings", key, value: JSON.stringify(value) })
        .onConflict((oc) =>
          oc.columns(["namespace", "key"]).doUpdateSet({ value: JSON.stringify(value) })
        )
        .execute();
    }

    // 4. Legacy key-value namespaces
    const kvNamespaces: Array<[string, Record<string, unknown> | undefined]> = [
      ["modelAliases", data.modelAliases],
      ["mitmAlias", data.mitmAlias],
      ["pricing", data.pricing],
      ["customModels", data.customModels],
    ];
    for (const [namespace, entries] of kvNamespaces) {
      for (const [key, value] of Object.entries(entries ?? {})) {
        await trx
          .insertInto("key_value")
          .values({ namespace, key, value: JSON.stringify(value) })
          .onConflict((oc) =>
            oc.columns(["namespace", "key"]).doUpdateSet({ value: JSON.stringify(value) })
          )
          .execute();
      }
    }
    if (data.proxyConfig) {
      const proxyConfigRows: Array<[string, unknown]> = [
        ["global", data.proxyConfig.global ?? null],
        ["providers", data.proxyConfig.providers ?? {}],
        ["combos", data.proxyConfig.combos ?? {}],
        ["keys", data.proxyConfig.keys ?? {}],
      ];
      for (const [key, value] of proxyConfigRows) {
        await trx
          .insertInto("key_value")
          .values({ namespace: "proxyConfig", key, value: JSON.stringify(value) })
          .onConflict((oc) =>
            oc.columns(["namespace", "key"]).doUpdateSet({ value: JSON.stringify(value) })
          )
          .execute();
      }
    }

    // 5. Combos
    for (const [index, combo] of (data.combos ?? []).entries()) {
      const normalizedCombo = normalizeCombo(combo, index);
      const values = {
        id: normalizedCombo.id as string,
        name: normalizedCombo.name as string,
        data: JSON.stringify(normalizedCombo),
        sort_order: normalizedCombo.sortOrder as number,
        created_at: (normalizedCombo.createdAt as string) ?? new Date().toISOString(),
        updated_at: (normalizedCombo.updatedAt as string) ?? new Date().toISOString(),
      };
      const { id, ...updateValues } = values;
      await trx
        .insertInto("combos")
        .values(values)
        .onConflict((oc) => oc.column("id").doUpdateSet(updateValues))
        .execute();
    }

    // 6. API Keys
    for (const apiKey of data.apiKeys ?? []) {
      const values = {
        id: apiKey.id as string,
        name: apiKey.name as string,
        key: apiKey.key as string,
        machine_id: (apiKey.machineId as string) ?? null,
        allowed_models: JSON.stringify(apiKey.allowedModels ?? []),
        no_log: Boolean(apiKey.noLog),
        created_at: (apiKey.createdAt as string) ?? new Date().toISOString(),
      };
      const { id, ...updateValues } = values;
      await trx
        .insertInto("api_keys")
        .values({ ...values, no_log: values.no_log as unknown as SqliteBoolean })
        .onConflict((oc) => oc.column("id").doUpdateSet(updateValues))
        .execute();
    }

    // 7. Usage History — usage_history.id is GENERATED ALWAYS AS IDENTITY on
    // Postgres, so explicit legacy ids need OVERRIDING SYSTEM VALUE (Kysely
    // has no builder method for this yet; raw SQL is the documented escape
    // hatch).
    for (const row of data.usageHistory ?? []) {
      await sql`
        INSERT INTO usage_history (
          id, provider, model, connection_id, api_key_id, api_key_name,
          tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation,
          tokens_reasoning, status, success, latency_ms, ttft_ms, error_code, combo_strategy, timestamp
        ) OVERRIDING SYSTEM VALUE VALUES (
          ${row.id}, ${row.provider ?? null}, ${row.model ?? null}, ${row.connection_id ?? null},
          ${row.api_key_id ?? null}, ${row.api_key_name ?? null},
          ${row.tokens_input ?? 0}, ${row.tokens_output ?? 0}, ${row.tokens_cache_read ?? 0},
          ${row.tokens_cache_creation ?? 0}, ${row.tokens_reasoning ?? 0}, ${row.status ?? null},
          ${row.success ?? 1}, ${row.latency_ms ?? 0}, ${row.ttft_ms ?? 0}, ${row.error_code ?? null},
          ${row.combo_strategy ?? "direct"}, ${row.timestamp}
        )
        ON CONFLICT (id) DO UPDATE SET
          provider = excluded.provider, model = excluded.model, connection_id = excluded.connection_id,
          api_key_id = excluded.api_key_id, api_key_name = excluded.api_key_name,
          tokens_input = excluded.tokens_input, tokens_output = excluded.tokens_output,
          tokens_cache_read = excluded.tokens_cache_read, tokens_cache_creation = excluded.tokens_cache_creation,
          tokens_reasoning = excluded.tokens_reasoning, status = excluded.status, success = excluded.success,
          latency_ms = excluded.latency_ms, ttft_ms = excluded.ttft_ms, error_code = excluded.error_code,
          combo_strategy = excluded.combo_strategy, timestamp = excluded.timestamp
      `.execute(trx);
    }

    // 8. Domain Cost History — same GENERATED ALWAYS AS IDENTITY situation as usage_history.
    for (const row of data.domainCostHistory ?? []) {
      await sql`
        INSERT INTO domain_cost_history (id, api_key_id, cost, timestamp)
        OVERRIDING SYSTEM VALUE VALUES (${row.id}, ${row.api_key_id}, ${row.cost}, ${row.timestamp})
        ON CONFLICT (id) DO UPDATE SET
          api_key_id = excluded.api_key_id, cost = excluded.cost, timestamp = excluded.timestamp
      `.execute(trx);
    }

    // 9. Domain Budgets
    for (const row of data.domainBudgets ?? []) {
      const values = {
        api_key_id: row.api_key_id as string,
        daily_limit_usd: row.daily_limit_usd as number,
        weekly_limit_usd: (row.weekly_limit_usd as number) ?? 0,
        monthly_limit_usd: (row.monthly_limit_usd as number) ?? 0,
        warning_threshold: (row.warning_threshold as number) ?? 0.8,
        reset_interval: (row.reset_interval as string) ?? "daily",
        reset_time: (row.reset_time as string) ?? "00:00",
        budget_reset_at: (row.budget_reset_at as number) ?? null,
        last_budget_reset_at: (row.last_budget_reset_at as number) ?? null,
        warning_emitted_at: (row.warning_emitted_at as number) ?? null,
        warning_period_start: (row.warning_period_start as number) ?? null,
      };
      const { api_key_id, ...updateValues } = values;
      await trx
        .insertInto("domain_budgets")
        .values(values)
        .onConflict((oc) => oc.column("api_key_id").doUpdateSet(updateValues))
        .execute();
    }
  });

  return {
    connections: (data.providerConnections ?? []).length,
    nodes: (data.providerNodes ?? []).length,
    combos: (data.combos ?? []).length,
    apiKeys: (data.apiKeys ?? []).length,
    usageHistory: (data.usageHistory ?? []).length,
    domainCostHistory: (data.domainCostHistory ?? []).length,
    domainBudgets: (data.domainBudgets ?? []).length,
  };
}

/**
 * Hydrates the active database (SQLite or Postgres) from a legacy JSON
 * backup object. `db` is only used (and required) on the SQLite path — pass
 * `null` when running under Postgres.
 */
export async function runJsonMigration(
  db: SqliteDatabase | null,
  data: LegacyJsonData
): Promise<MigrationCounts> {
  if (isPostgres()) {
    return migratePg(data);
  }

  if (!db) {
    throw new Error("runJsonMigration: db is required on the SQLite path");
  }

  const insertConn = db.prepare(`
    INSERT OR REPLACE INTO provider_connections (
      id, provider, auth_type, name, email, priority, is_active,
      access_token, refresh_token, expires_at, token_expires_at,
      scope, project_id, test_status, error_code, last_error,
      last_error_at, last_error_type, last_error_source, backoff_level,
      rate_limited_until, health_check_interval, last_health_check_at,
      last_tested, api_key, id_token, provider_specific_data,
      expires_in, display_name, global_priority, default_model,
      token_type, consecutive_use_count, rate_limit_protection, last_used_at, created_at, updated_at
    ) VALUES (
      @id, @provider, @authType, @name, @email, @priority, @isActive,
      @accessToken, @refreshToken, @expiresAt, @tokenExpiresAt,
      @scope, @projectId, @testStatus, @errorCode, @lastError,
      @lastErrorAt, @lastErrorType, @lastErrorSource, @backoffLevel,
      @rateLimitedUntil, @healthCheckInterval, @lastHealthCheckAt,
      @lastTested, @apiKey, @idToken, @providerSpecificData,
      @expiresIn, @displayName, @globalPriority, @defaultModel,
      @tokenType, @consecutiveUseCount, @rateLimitProtection, @lastUsedAt, @createdAt, @updatedAt
    )
  `);

  const insertNode = db.prepare(`
    INSERT OR REPLACE INTO provider_nodes (id, type, name, prefix, api_type, base_url, created_at, updated_at)
    VALUES (@id, @type, @name, @prefix, @apiType, @baseUrl, @createdAt, @updatedAt)
  `);

  const insertKv = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
  );

  const insertCombo = db.prepare(`
    INSERT OR REPLACE INTO combos (id, name, data, sort_order, created_at, updated_at)
    VALUES (@id, @name, @data, @sortOrder, @createdAt, @updatedAt)
  `);

  const insertKey = db.prepare(`
    INSERT OR REPLACE INTO api_keys (id, name, key, machine_id, allowed_models, no_log, created_at)
    VALUES (@id, @name, @key, @machineId, @allowedModels, @noLog, @createdAt)
  `);

  const migrate = db.transaction(() => {
    // 1. Provider Connections
    for (const conn of data.providerConnections ?? []) {
      insertConn.run({
        id: conn.id,
        provider: conn.provider,
        authType: conn.authType ?? "oauth",
        name: conn.name ?? null,
        email: conn.email ?? null,
        priority: conn.priority ?? 0,
        isActive: conn.isActive === false ? 0 : 1,
        accessToken: conn.accessToken ?? null,
        refreshToken: conn.refreshToken ?? null,
        expiresAt: conn.expiresAt ?? null,
        tokenExpiresAt: conn.tokenExpiresAt ?? null,
        scope: conn.scope ?? null,
        projectId: conn.projectId ?? null,
        testStatus: conn.testStatus ?? null,
        errorCode: conn.errorCode ?? null,
        lastError: conn.lastError ?? null,
        lastErrorAt: conn.lastErrorAt ?? null,
        lastErrorType: conn.lastErrorType ?? null,
        lastErrorSource: conn.lastErrorSource ?? null,
        backoffLevel: conn.backoffLevel ?? 0,
        rateLimitedUntil: conn.rateLimitedUntil ?? null,
        healthCheckInterval: conn.healthCheckInterval ?? null,
        lastHealthCheckAt: conn.lastHealthCheckAt ?? null,
        lastTested: conn.lastTested ?? null,
        apiKey: conn.apiKey ?? null,
        idToken: conn.idToken ?? null,
        providerSpecificData: conn.providerSpecificData ?? null,
        expiresIn: conn.expiresIn ?? null,
        displayName: conn.displayName ?? null,
        globalPriority: conn.globalPriority ?? null,
        defaultModel: conn.defaultModel ?? null,
        tokenType: conn.tokenType ?? null,
        consecutiveUseCount: conn.consecutiveUseCount ?? 0,
        rateLimitProtection:
          conn.rateLimitProtection === true || conn.rateLimitProtection === 1 ? 1 : 0,
        createdAt: conn.createdAt ?? new Date().toISOString(),
        updatedAt: conn.updatedAt ?? new Date().toISOString(),
      });
    }

    // 2. Provider Nodes
    for (const node of data.providerNodes ?? []) {
      insertNode.run({
        id: node.id,
        type: node.type,
        name: node.name,
        prefix: node.prefix ?? null,
        apiType: node.apiType ?? null,
        baseUrl: node.baseUrl ?? null,
        createdAt: node.createdAt ?? new Date().toISOString(),
        updatedAt: node.updatedAt ?? new Date().toISOString(),
      });
    }

    // 3. Key-Value Settings (caller must have stripped password / requireLogin)
    for (const [key, value] of Object.entries(data.settings ?? {})) {
      insertKv.run("settings", key, JSON.stringify(value));
    }

    // 4. Legacy key-value namespaces
    for (const [alias, model] of Object.entries(data.modelAliases ?? {})) {
      insertKv.run("modelAliases", alias, JSON.stringify(model));
    }
    for (const [toolName, mappings] of Object.entries(data.mitmAlias ?? {})) {
      insertKv.run("mitmAlias", toolName, JSON.stringify(mappings));
    }
    for (const [provider, models] of Object.entries(data.pricing ?? {})) {
      insertKv.run("pricing", provider, JSON.stringify(models));
    }
    for (const [providerId, models] of Object.entries(data.customModels ?? {})) {
      insertKv.run("customModels", providerId, JSON.stringify(models));
    }
    if (data.proxyConfig) {
      insertKv.run("proxyConfig", "global", JSON.stringify(data.proxyConfig.global ?? null));
      insertKv.run("proxyConfig", "providers", JSON.stringify(data.proxyConfig.providers ?? {}));
      insertKv.run("proxyConfig", "combos", JSON.stringify(data.proxyConfig.combos ?? {}));
      insertKv.run("proxyConfig", "keys", JSON.stringify(data.proxyConfig.keys ?? {}));
    }

    // 5. Combos
    for (const [index, combo] of (data.combos ?? []).entries()) {
      const normalizedCombo = normalizeCombo(combo, index);
      insertCombo.run({
        id: normalizedCombo.id,
        name: normalizedCombo.name,
        data: JSON.stringify(normalizedCombo),
        sortOrder: normalizedCombo.sortOrder,
        createdAt: normalizedCombo.createdAt ?? new Date().toISOString(),
        updatedAt: normalizedCombo.updatedAt ?? new Date().toISOString(),
      });
    }

    // 6. API Keys
    for (const apiKey of data.apiKeys ?? []) {
      insertKey.run({
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key,
        machineId: apiKey.machineId ?? null,
        allowedModels: JSON.stringify(apiKey.allowedModels ?? []),
        noLog: apiKey.noLog ? 1 : 0,
        createdAt: apiKey.createdAt ?? new Date().toISOString(),
      });
    }
    // 7. Usage History
    if (data.usageHistory && data.usageHistory.length > 0) {
      const insertUsageHistory = db.prepare(`
        INSERT OR REPLACE INTO usage_history (
          id, provider, model, connection_id, api_key_id, api_key_name,
          tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation,
          tokens_reasoning, status, success, latency_ms, ttft_ms, error_code, combo_strategy, timestamp
        ) VALUES (
          @id, @provider, @model, @connection_id, @api_key_id, @api_key_name,
          @tokens_input, @tokens_output, @tokens_cache_read, @tokens_cache_creation,
          @tokens_reasoning, @status, @success, @latency_ms, @ttft_ms, @error_code, @combo_strategy, @timestamp
        )
      `);
      for (const row of data.usageHistory) {
        insertUsageHistory.run({
          id: row.id,
          provider: row.provider ?? null,
          model: row.model ?? null,
          connection_id: row.connection_id ?? null,
          api_key_id: row.api_key_id ?? null,
          api_key_name: row.api_key_name ?? null,
          tokens_input: row.tokens_input ?? 0,
          tokens_output: row.tokens_output ?? 0,
          tokens_cache_read: row.tokens_cache_read ?? 0,
          tokens_cache_creation: row.tokens_cache_creation ?? 0,
          tokens_reasoning: row.tokens_reasoning ?? 0,
          status: row.status ?? null,
          success: row.success ?? 1,
          latency_ms: row.latency_ms ?? 0,
          ttft_ms: row.ttft_ms ?? 0,
          error_code: row.error_code ?? null,
          combo_strategy: row.combo_strategy ?? "direct",
          timestamp: row.timestamp,
        });
      }
    }

    // 8. Domain Cost History
    if (data.domainCostHistory && data.domainCostHistory.length > 0) {
      const insertCostHistory = db.prepare(`
        INSERT OR REPLACE INTO domain_cost_history (
          id, api_key_id, cost, timestamp
        ) VALUES (
          @id, @api_key_id, @cost, @timestamp
        )
      `);
      for (const row of data.domainCostHistory) {
        insertCostHistory.run({
          id: row.id,
          api_key_id: row.api_key_id,
          cost: row.cost,
          timestamp: row.timestamp,
        });
      }
    }

    // 9. Domain Budgets
    if (data.domainBudgets && data.domainBudgets.length > 0) {
      const insertBudgets = db.prepare(`
        INSERT OR REPLACE INTO domain_budgets (
          api_key_id, daily_limit_usd, weekly_limit_usd, monthly_limit_usd,
          warning_threshold, reset_interval, reset_time, budget_reset_at,
          last_budget_reset_at, warning_emitted_at, warning_period_start
        ) VALUES (
          @api_key_id, @daily_limit_usd, @weekly_limit_usd, @monthly_limit_usd,
          @warning_threshold, @reset_interval, @reset_time, @budget_reset_at,
          @last_budget_reset_at, @warning_emitted_at, @warning_period_start
        )
      `);
      for (const row of data.domainBudgets) {
        insertBudgets.run({
          api_key_id: row.api_key_id,
          daily_limit_usd: row.daily_limit_usd,
          weekly_limit_usd: row.weekly_limit_usd ?? 0,
          monthly_limit_usd: row.monthly_limit_usd ?? 0,
          warning_threshold: row.warning_threshold ?? 0.8,
          reset_interval: row.reset_interval ?? "daily",
          reset_time: row.reset_time ?? "00:00",
          budget_reset_at: row.budget_reset_at ?? null,
          last_budget_reset_at: row.last_budget_reset_at ?? null,
          warning_emitted_at: row.warning_emitted_at ?? null,
          warning_period_start: row.warning_period_start ?? null,
        });
      }
    }
  });

  migrate();

  return {
    connections: (data.providerConnections ?? []).length,
    nodes: (data.providerNodes ?? []).length,
    combos: (data.combos ?? []).length,
    apiKeys: (data.apiKeys ?? []).length,
    usageHistory: (data.usageHistory ?? []).length,
    domainCostHistory: (data.domainCostHistory ?? []).length,
    domainBudgets: (data.domainBudgets ?? []).length,
  };
}
