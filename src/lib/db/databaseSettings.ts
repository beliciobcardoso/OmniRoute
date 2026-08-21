import fs from "node:fs";

import { DEFAULT_DATABASE_SETTINGS, type DatabaseSettings } from "@/types/databaseSettings";

import { backupDbFile } from "./backup";
import { DATA_DIR, SQLITE_FILE, applyDatabaseOptimizationSettings, getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";
import { invalidateDbCache } from "./readCache";
import { getDatabaseStats } from "./stats";
import { getState as getVacuumSchedulerState, refreshVacuumScheduler } from "./vacuumScheduler";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("DB_DATABASE_SETTINGS");
const DATABASE_SETTINGS_NAMESPACE = "databaseSettings";
const SETTINGS_NAMESPACE = "settings";
const PG_NAMESPACES = [SETTINGS_NAMESPACE, DATABASE_SETTINGS_NAMESPACE];

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

/**
 * In-memory cache of the Postgres-backed key_value rows for the "settings"
 * and "databaseSettings" namespaces.
 *
 * getUserDatabaseSettings()/getDatabaseSettings() MUST stay synchronous —
 * they're read from ~20 call sites across dashboard routes and hot-path
 * modules (paramFilters.ts, interceptionRules.ts) that cannot become async
 * without a much larger ripple. Settings changes are rare, operator-triggered
 * admin actions, so a short staleness window plus a best-effort,
 * fire-and-forget Postgres write on update is an accepted trade-off (same
 * pattern as featureFlags.ts/cliToolState.ts).
 */
let pgCache: Record<string, Record<string, string>> | null = null;
let pgCacheLoadedAt = 0;
let pgCacheLoadInFlight: Promise<void> | null = null;
// Monotonic write counter — see featureFlags.ts for why Date.now() alone is
// not a reliable staleness guard against a background refresh racing a write.
let pgCacheEpoch = 0;
const PG_CACHE_TTL_MS = 30_000;

function refreshPgCacheInBackground(): void {
  if (pgCacheLoadInFlight) return;
  const epochAtStart = pgCacheEpoch;
  pgCacheLoadInFlight = (async () => {
    try {
      await ensurePostgresBootstrap();
      const rows = await getKyselyDb()
        .selectFrom("key_value")
        .select(["namespace", "key", "value"])
        .where("namespace", "in", PG_NAMESPACES)
        .execute();
      const next: Record<string, Record<string, string>> = {};
      for (const ns of PG_NAMESPACES) next[ns] = {};
      for (const row of rows) {
        (next[row.namespace] ??= {})[row.key] = row.value;
      }
      if (pgCacheEpoch === epochAtStart) {
        pgCache = next;
        pgCacheLoadedAt = Date.now();
      }
    } catch (err) {
      log.warn("database_settings.pg_cache_refresh_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pgCacheLoadInFlight = null;
    }
  })();
}

function getPgNamespace(namespace: string): Record<string, string> {
  if (pgCache === null || Date.now() - pgCacheLoadedAt > PG_CACHE_TTL_MS) {
    refreshPgCacheInBackground();
  }
  return pgCache?.[namespace] ?? {};
}

function persistPgRows(rows: Array<{ namespace: string; key: string; value: string }>): void {
  if (rows.length === 0) return;

  pgCache = pgCache ?? {};
  for (const row of rows) {
    (pgCache[row.namespace] ??= {})[row.key] = row.value;
  }
  pgCacheLoadedAt = Date.now();
  pgCacheEpoch++;

  void (async () => {
    try {
      await ensurePostgresBootstrap();
      await getKyselyDb()
        .insertInto("key_value")
        .values(rows)
        .onConflict((oc) =>
          oc
            .columns(["namespace", "key"])
            .doUpdateSet((eb) => ({ value: eb.ref("excluded.value") }))
        )
        .execute();
    } catch (err) {
      log.warn("database_settings.pg_persist_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

export type UserDatabaseSettings = Omit<DatabaseSettings, "location" | "stats">;
type DatabaseSettingsSection = keyof UserDatabaseSettings;

const DATABASE_SETTINGS_SECTIONS = Object.keys(
  DEFAULT_DATABASE_SETTINGS
) as DatabaseSettingsSection[];

const LEGACY_FLAT_KEYS: {
  [TSection in DatabaseSettingsSection]: Partial<
    Record<keyof UserDatabaseSettings[TSection] & string, string[]>
  >;
} = {
  logs: {
    detailedLogsEnabled: ["detailedLogsEnabled"],
    callLogPipelineEnabled: ["callLogPipelineEnabled"],
    maxDetailSizeKb: ["maxDetailSizeKb"],
    ringBufferSize: ["ringBufferSize"],
  },
  backup: {
    autoBackupEnabled: ["autoBackupEnabled"],
    autoBackupFrequency: ["autoBackupFrequency"],
    keepLastNBackups: ["keepLastNBackups"],
  },
  cache: {
    semanticCacheEnabled: ["semanticCacheEnabled"],
    semanticCacheMaxSize: ["semanticCacheMaxSize"],
    semanticCacheTTL: ["semanticCacheTTL"],
    promptCacheEnabled: ["promptCacheEnabled"],
    promptCacheStrategy: ["promptCacheStrategy"],
    alwaysPreserveClientCache: ["alwaysPreserveClientCache"],
  },
  retention: {
    quotaSnapshots: ["quotaSnapshots"],
    compressionAnalytics: ["compressionAnalytics"],
    mcpAudit: ["mcpAudit"],
    a2aEvents: ["a2aEvents"],
    callLogs: ["callLogs"],
    usageHistory: ["usageHistory"],
    memoryEntries: ["memoryEntries"],
    autoCleanupEnabled: ["autoCleanupEnabled"],
  },
  aggregation: {
    enabled: ["aggregationEnabled", "enabled"],
    rawDataRetentionDays: ["rawDataRetentionDays"],
    granularity: ["granularity"],
  },
  optimization: {
    autoVacuumMode: ["autoVacuumMode"],
    scheduledVacuum: ["scheduledVacuum"],
    vacuumHour: ["vacuumHour"],
    pageSize: ["pageSize"],
    cacheSize: ["cacheSize"],
    optimizeOnStartup: ["optimizeOnStartup"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultSettings(): UserDatabaseSettings {
  return structuredClone(DEFAULT_DATABASE_SETTINGS) as UserDatabaseSettings;
}

function parseStoredValue(rawValue: unknown): unknown {
  if (typeof rawValue !== "string") return rawValue;

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function toBooleanSetting(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return !Number.isNaN(value) && value !== 0;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function normalizeOptimizationSettings(settings: UserDatabaseSettings) {
  const fallback = DEFAULT_DATABASE_SETTINGS.optimization.cacheSize;
  const numericCacheSize = Number(settings.optimization.cacheSize);
  settings.optimization.cacheSize =
    Number.isFinite(numericCacheSize) && numericCacheSize > 0
      ? Math.min(1000000, Math.floor(numericCacheSize))
      : fallback;
}

function readNamespace(namespace: string): Record<string, unknown> {
  if (isPostgres()) {
    const raw = getPgNamespace(namespace);
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      values[key] = parseStoredValue(value);
    }
    return values;
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(namespace) as Array<{ key: string; value: string }>;

  const values: Record<string, unknown> = {};
  for (const row of rows) {
    values[row.key] = parseStoredValue(row.value);
  }
  return values;
}

function mergeSectionObject(
  target: UserDatabaseSettings,
  section: DatabaseSettingsSection,
  value: unknown
) {
  if (!isRecord(value)) return;

  const sectionTarget = target[section] as Record<string, unknown>;
  const defaultSection = DEFAULT_DATABASE_SETTINGS[section] as Record<string, unknown>;

  for (const key of Object.keys(defaultSection)) {
    if (value[key] !== undefined) {
      sectionTarget[key] = value[key];
    }
  }
}

function mergeTopLevelSections(target: UserDatabaseSettings, values: Record<string, unknown>) {
  for (const section of DATABASE_SETTINGS_SECTIONS) {
    mergeSectionObject(target, section, values[section]);
  }
}

function mergeRuntimeLogSettings(target: UserDatabaseSettings, values: Record<string, unknown>) {
  const pipelineEnabled = toBooleanSetting(values.call_log_pipeline_enabled);
  if (pipelineEnabled !== null) {
    target.logs.callLogPipelineEnabled = pipelineEnabled;
  }

  const legacyDetailedEnabled = toBooleanSetting(values.detailed_logs_enabled);
  if (legacyDetailedEnabled !== null) {
    target.logs.detailedLogsEnabled = legacyDetailedEnabled;
  }
}

function mergeDatabaseSettingsNamespace(
  target: UserDatabaseSettings,
  values: Record<string, unknown>
) {
  for (const section of DATABASE_SETTINGS_SECTIONS) {
    const defaultSection = DEFAULT_DATABASE_SETTINGS[section] as Record<string, unknown>;
    const sectionTarget = target[section] as Record<string, unknown>;
    const flatAliases = LEGACY_FLAT_KEYS[section] as Partial<Record<string, string[]>>;

    for (const key of Object.keys(defaultSection)) {
      for (const alias of flatAliases[key] ?? []) {
        if (values[alias] !== undefined) {
          sectionTarget[key] = values[alias];
        }
      }

      const nestedKey = `${section}.${key}`;
      if (values[nestedKey] !== undefined) {
        sectionTarget[key] = values[nestedKey];
      }
    }
  }
}

function getWalSizeBytes(): number {
  if (isPostgres() || !SQLITE_FILE) return 0;

  try {
    const walPath = `${SQLITE_FILE}-wal`;
    return fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  } catch {
    return 0;
  }
}

function getSchemaVersion(): number {
  if (isPostgres()) return 0;

  const db = getDbInstance();

  try {
    const row = db
      .prepare("SELECT MAX(CAST(version AS INTEGER)) AS version FROM _omniroute_migrations")
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

function getFreelistCount(): number {
  if (isPostgres()) return 0;

  try {
    return getDbInstance().pragma("freelist_count", { simple: true }) as number;
  } catch {
    return 0;
  }
}

function getIntegrityCheck(): "ok" | "error" | null {
  if (isPostgres()) return null;

  try {
    const result = getDbInstance().pragma("quick_check", { simple: true }) as string;
    return result === "ok" ? "ok" : "error";
  } catch {
    return null;
  }
}

export function getUserDatabaseSettings(): UserDatabaseSettings {
  const settings = cloneDefaultSettings();
  const mainSettings = readNamespace("settings");
  const databaseSettingsValue = mainSettings[DATABASE_SETTINGS_NAMESPACE];

  if (isRecord(databaseSettingsValue)) {
    mergeTopLevelSections(settings, databaseSettingsValue);
  }

  mergeTopLevelSections(settings, mainSettings);
  mergeDatabaseSettingsNamespace(settings, readNamespace(DATABASE_SETTINGS_NAMESPACE));
  mergeRuntimeLogSettings(settings, mainSettings);
  normalizeOptimizationSettings(settings);

  return settings;
}

export function getDatabaseSettings(): DatabaseSettings {
  // The SQLite pragma/WAL/freelist diagnostics below have no direct Postgres
  // equivalent — under DB_DRIVER=postgres they report stub/N-A values rather
  // than the coexisting SQLite file's (unrelated) stats.
  const dbStats = isPostgres() ? { totalSize: 0, pageCount: 0 } : getDatabaseStats();
  const vacuumState = getVacuumSchedulerState();

  return {
    ...getUserDatabaseSettings(),
    location: {
      databasePath: isPostgres() ? "postgres" : (SQLITE_FILE ?? ":memory:"),
      dataDir: DATA_DIR,
      walSizeBytes: getWalSizeBytes(),
      schemaVersion: getSchemaVersion(),
    },
    stats: {
      databaseSizeBytes: dbStats.totalSize,
      pageCount: dbStats.pageCount,
      freelistCount: getFreelistCount(),
      lastVacuumAt:
        vacuumState.lastRunAt !== null ? new Date(vacuumState.lastRunAt).toISOString() : null,
      lastOptimizationAt: null,
      integrityCheck: getIntegrityCheck(),
    },
  };
}

export function updateDatabaseSettings(
  updates: Partial<UserDatabaseSettings>
): UserDatabaseSettings {
  const nextSettings = getUserDatabaseSettings();
  const optimizationUpdated = updates.optimization !== undefined;

  for (const section of DATABASE_SETTINGS_SECTIONS) {
    if (updates[section] !== undefined) {
      mergeSectionObject(nextSettings, section, updates[section]);
    }
  }
  normalizeOptimizationSettings(nextSettings);

  const requestedLogs = updates.logs as Partial<UserDatabaseSettings["logs"]> | undefined;
  const pipelineEnabled = requestedLogs?.callLogPipelineEnabled;
  const detailedEnabled = requestedLogs?.detailedLogsEnabled;

  if (isPostgres()) {
    const rows: Array<{ namespace: string; key: string; value: string }> = [];
    for (const section of DATABASE_SETTINGS_SECTIONS) {
      const sectionValues = nextSettings[section] as Record<string, unknown>;
      for (const [key, value] of Object.entries(sectionValues)) {
        rows.push({
          namespace: DATABASE_SETTINGS_NAMESPACE,
          key: `${section}.${key}`,
          value: JSON.stringify(value),
        });
      }
    }
    if (pipelineEnabled !== undefined) {
      rows.push({
        namespace: SETTINGS_NAMESPACE,
        key: "call_log_pipeline_enabled",
        value: JSON.stringify(Boolean(pipelineEnabled)),
      });
    }
    persistPgRows(rows);
  } else {
    const db = getDbInstance();
    const insert = db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
    );
    const settingsInsert = db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)"
    );

    const tx = db.transaction(() => {
      for (const section of DATABASE_SETTINGS_SECTIONS) {
        const sectionValues = nextSettings[section] as Record<string, unknown>;

        for (const [key, value] of Object.entries(sectionValues)) {
          insert.run(DATABASE_SETTINGS_NAMESPACE, `${section}.${key}`, JSON.stringify(value));
        }
      }

      if (pipelineEnabled !== undefined) {
        settingsInsert.run("call_log_pipeline_enabled", JSON.stringify(Boolean(pipelineEnabled)));
      }
    });
    tx();

    backupDbFile("pre-write");
  }

  invalidateDbCache("settings");
  if (optimizationUpdated) {
    applyDatabaseOptimizationSettings(nextSettings.optimization);
    refreshVacuumScheduler();
  }

  return nextSettings;
}
