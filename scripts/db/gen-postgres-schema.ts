#!/usr/bin/env node
/**
 * Generates the Postgres schema for the opt-in Postgres persistence backend from
 * the real, fully-migrated SQLite schema (core.ts SCHEMA_SQL + every migration),
 * introspected with PRAGMA — the migrations alone are not a reliable source of
 * truth (some are auto-seeded as applied).
 *
 * Outputs (both AUTO-GENERATED, never edit by hand):
 *   src/lib/db/postgres/bootstrapSql.ts  greenfield DDL (CREATE ... IF NOT EXISTS)
 *   src/lib/db/postgres/schema.ts        Kysely `Database` types
 *
 * Usage:
 *   npm run gen:postgres-schema     regenerate after adding a SQLite migration
 *   npm run check:postgres-schema   fail if the committed output is stale
 *
 * Every Postgres-specific decision the generator cannot infer (boolean columns,
 * SQLite-only tables, untranslatable indexes) lives in
 * src/lib/db/postgres/schemaOverrides.ts. Unknown constructs fail loudly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_SQL = path.join(REPO_ROOT, "src/lib/db/postgres/bootstrapSql.ts");
const OUT_TS = path.join(REPO_ROOT, "src/lib/db/postgres/schema.ts");

type Row = Record<string, unknown>;

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

type PgType = "BIGINT" | "TEXT" | "DOUBLE PRECISION" | "BOOLEAN" | "BYTEA";

interface PgColumn {
  name: string;
  pgType: PgType;
  notNull: boolean;
  defaultSql: string | null;
  identity: boolean;
}

interface PgTable {
  name: string;
  columns: PgColumn[];
  primaryKey: string[];
  uniques: string[][];
}

// SQLite CURRENT_TIMESTAMP / datetime('now') text format: "YYYY-MM-DD HH:MM:SS" in UTC.
const NOW_TEXT = "(to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'))";
const NOW_ISO_MS =
  "(to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))";
const NOW_ISO_S = "(to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))";
// lower(hex(randomblob(8))): 16 random lowercase hex chars; gen_random_uuid() is built in (PG13+).
const RANDOM_HEX_16 = "(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))";
const NOW_EPOCH_S = "(EXTRACT(EPOCH FROM now())::BIGINT)";
const NOW_EPOCH_MS = "((EXTRACT(EPOCH FROM now()) * 1000)::BIGINT)";

const PG_RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast " +
    "check collate collation column concurrently constraint create cross current_catalog " +
    "current_date current_role current_schema current_time current_timestamp current_user " +
    "default deferrable desc distinct do else end except false fetch for foreign freeze from " +
    "full grant group having ilike in initially inner intersect into is isnull join lateral " +
    "leading left like limit localtime localtimestamp natural not notnull null offset on only " +
    "or order outer overlaps placing primary references returning right select session_user " +
    "similar some symmetric table tablesample then to trailing true union unique user using " +
    "variadic verbose when where window with"
  ).split(" ")
);

export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

/** SQLite type affinity rules (https://www.sqlite.org/datatype3.html §3.1) → Postgres. */
export function mapType(declared: string, isBoolean: boolean, where: string): PgType {
  const t = declared.toUpperCase();
  if (isBoolean) {
    if (!t.includes("INT") && t !== "BOOLEAN") {
      throw new Error(`${where}: listed as boolean but declared ${declared || "(none)"}`);
    }
    return "BOOLEAN";
  }
  if (t.includes("INT")) return "BIGINT";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB")) return "BYTEA";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "DOUBLE PRECISION";
  if (t === "" || t === "JSON") return "TEXT";
  if (t === "BOOLEAN") return "BOOLEAN";
  if (t === "DATETIME" || t === "DATE" || t === "TIMESTAMP") return "TEXT";
  if (t === "NUMERIC" || t.startsWith("DECIMAL")) return "DOUBLE PRECISION";
  throw new Error(`${where}: unsupported SQLite type "${declared}"`);
}

function unwrapParens(value: string): string {
  let v = value.trim();
  while (v.startsWith("(") && v.endsWith(")")) v = v.slice(1, -1).trim();
  return v;
}

export function mapDefault(raw: string | null, pgType: PgType, where: string): string | null {
  if (raw === null) return null;
  const v = unwrapParens(raw);
  const norm = v.replace(/\s+/g, "").toLowerCase();

  if (norm === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    if (pgType === "BOOLEAN") {
      if (v === "0") return "FALSE";
      if (v === "1") return "TRUE";
      throw new Error(`${where}: boolean column with default ${v}`);
    }
    return v;
  }
  // SQLite falls back to a string literal for a double-quoted default that names no column.
  if (/^"[^"]*"$/.test(v)) return mapDefault(`'${v.slice(1, -1).replace(/'/g, "''")}'`, pgType, where);
  if (/^'(?:[^']|'')*'$/s.test(v)) {
    if (pgType === "BOOLEAN" || pgType === "BIGINT" || pgType === "DOUBLE PRECISION") {
      throw new Error(`${where}: string default ${v} on ${pgType} column`);
    }
    return v;
  }
  if (norm === "current_timestamp" || norm === "datetime('now')") return NOW_TEXT;
  if (norm === "strftime('%y-%m-%dt%h:%m:%fz','now')") return NOW_ISO_MS;
  if (norm === "strftime('%y-%m-%dt%h:%m:%sz','now')") return NOW_ISO_S;
  if (norm === "lower(hex(randomblob(8)))") return RANDOM_HEX_16;
  if (
    norm === "strftime('%s','now')" ||
    norm === "cast(strftime('%s','now')asinteger)" ||
    norm === "unixepoch()" ||
    norm === "unixepoch('now')"
  ) {
    return NOW_EPOCH_S;
  }
  if (
    norm === "strftime('%s','now')*1000" ||
    norm === "cast(strftime('%s','now')asinteger)*1000" ||
    norm === "unixepoch()*1000" ||
    norm === "cast(unixepoch('subsec')*1000asinteger)"
  ) {
    return NOW_EPOCH_MS;
  }
  throw new Error(`${where}: untranslatable default ${raw}`);
}

/**
 * Several modules create tables / add columns lazily on first use instead of
 * through a migration. Run each of them so the introspected schema is the one a
 * live server converges to. collectStaticDdl() below fails the run if a lazy DDL
 * site exists that no trigger reached.
 */
type LazyTrigger = [modulePath: string, run: (mod: any, db: unknown) => unknown]; // eslint-disable-line @typescript-eslint/no-explicit-any -- dynamic import of heterogeneous modules

const LAZY_SCHEMA_TRIGGERS: LazyTrigger[] = [
  ["src/lib/db/apiKeyColumnFallbacks.ts", (m, db) => m.ensureApiKeyFallbackColumns(db)],
  [
    "src/lib/db/schemaColumns.ts",
    (m, db) => {
      m.ensureProviderConnectionsColumns(db);
      m.ensureUsageHistoryColumns(db);
      m.ensureCallLogsColumns(db);
      m.ensureProxyLogsColumns(db);
    },
  ],
  ["src/lib/cloudAgent/db.ts", (m) => m.createCloudAgentTaskTable()],
  ["src/lib/compliance/index.ts", (m) => m.initAuditLog()],
  ["src/lib/db/compressionAnalytics.ts", (m) => m.getPerEngineAnalytics("schema-generator", 1)],
  ["src/lib/db/compressionCombos.ts", (m) => m.listCompressionCombos()],
  ["src/lib/db/compressionRunTelemetry.ts", (m) => m.ensureCompressionRunTelemetryTable()],
  ["src/lib/db/domainState.ts", (m) => m.loadAllBudgets()],
  ["src/lib/db/evals.ts", (m) => m.listCustomEvalSuites()],
  ["src/lib/db/prompts.ts", (m) => m.getActivePrompt("schema-generator")],
  ["src/lib/db/syncTokens.ts", (m) => m.listSyncTokens()],
  ["src/lib/db/tierConfig.ts", (m) => m.initTierConfigTable()],
  ["src/lib/db/tokenLimits.ts", (m) => m.listTokenLimits("schema-generator")],
  ["src/lib/modelsDevSync.ts", (m) => m.ensureCapabilitiesTable()],
  ["src/lib/semanticCache.ts", (m) => m.getMemoryCacheStats()],
];

/**
 * Lazy-DDL sites intentionally not reached by a trigger. Path → reason.
 */
const STATIC_DDL_IGNORED: ReadonlyMap<string, string> = new Map([
  [
    "src/domain/assessment/migration.ts",
    "runAssessmentMigration() opens a separate database file and has no callers",
  ],
  ["open-sse/services/compression/eval/seedCorpus.ts", "SQL text inside an eval corpus string"],
]);

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (/\.(c|m)?tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Statically lists every literal lazy `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN` outside migrations. */
function collectStaticDdl(): { tables: Set<string>; columns: Set<string> } {
  const tables = new Set<string>();
  const columns = new Set<string>();
  for (const root of ["src", "open-sse"]) {
    for (const file of walkTs(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (
        rel.startsWith("src/lib/db/migrations/") ||
        rel.startsWith("src/lib/db/postgres/") ||
        rel === "src/lib/db/core.ts" ||
        STATIC_DDL_IGNORED.has(rel)
      ) {
        continue;
      }
      const source = fs.readFileSync(file, "utf8");
      for (const m of source.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+["`]?([a-z_][a-z0-9_]*)/gi)) {
        tables.add(m[1]);
      }
      for (const m of source.matchAll(
        /ALTER\s+TABLE\s+["`]?([a-z_][a-z0-9_]*)["`]?\s+ADD\s+COLUMN\s+["`]?([a-z_][a-z0-9_]*)/gi
      )) {
        columns.add(`${m[1]}.${m[2]}`);
      }
    }
  }
  return { tables, columns };
}

function introspect(db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }) {
  const master = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name")
    .all() as Row[];

  const virtualTables = master
    .filter((r) => r.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(r.sql ?? "")))
    .map((r) => String(r.name));
  return { master, virtualTables };
}

function isExcludedTable(name: string, virtualTables: string[], sqliteOnly: ReadonlyMap<string, string>) {
  if (name.startsWith("sqlite_")) return true;
  if (sqliteOnly.has(name)) return true;
  return virtualTables.some((v) => name === v || name.startsWith(`${v}_`));
}

function pascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function tsType(pgType: PgType): string {
  switch (pgType) {
    case "BIGINT":
    case "DOUBLE PRECISION":
      return "number";
    case "BOOLEAN":
      return "boolean";
    case "BYTEA":
      return "Buffer";
    default:
      return "string";
  }
}

function tsKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export async function generate(): Promise<{ sql: string; ts: string }> {
  const overrides = await import("../../src/lib/db/postgres/schemaOverrides.ts");
  const { BOOLEAN_COLUMNS, SQLITE_ONLY_TABLES, INDEX_OVERRIDES } = overrides;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pg-schema-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  const core = await import("../../src/lib/db/core.ts");

  try {
    const db = core.getDbInstance();
    for (const [modulePath, run] of LAZY_SCHEMA_TRIGGERS) {
      const mod = await import(path.join(REPO_ROOT, modulePath));
      await run(mod, db);
    }
    const { master, virtualTables } = introspect(db);

    const staticDdl = collectStaticDdl();
    const liveTables = new Set(master.filter((r) => r.type === "table").map((r) => String(r.name)));
    const unreachedDdl = [
      ...[...staticDdl.tables].filter((t) => !liveTables.has(t)).map((t) => `table ${t}`),
      ...[...staticDdl.columns]
        .filter((key) => {
          const [table, column] = key.split(".");
          if (!liveTables.has(table)) return true;
          const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
          return !cols.some((c) => c.name === column);
        })
        .map((key) => `column ${key}`),
    ];
    if (unreachedDdl.length > 0) {
      throw new Error(
        "Lazy DDL found in source but not present after LAZY_SCHEMA_TRIGGERS ran — add a " +
          `trigger (or a STATIC_DDL_IGNORED entry with a reason):\n  - ${unreachedDdl.join("\n  - ")}`
      );
    }
    const seenBooleans = new Set<string>();
    const usedIndexOverrides = new Set<string>();
    const nocaseColumns: string[] = [];
    const problems: string[] = [];
    const attempt = <T,>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (err) {
        problems.push((err as Error).message);
        return fallback;
      }
    };

    const tableNames = master
      .filter((r) => r.type === "table")
      .map((r) => String(r.name))
      .filter((name) => !isExcludedTable(name, virtualTables, SQLITE_ONLY_TABLES))
      .sort();
    const tableSet = new Set(tableNames);

    for (const name of SQLITE_ONLY_TABLES.keys()) {
      if (!master.some((r) => r.type === "table" && r.name === name)) {
        throw new Error(`schemaOverrides: SQLITE_ONLY_TABLES lists missing table "${name}"`);
      }
    }

    const tables: PgTable[] = [];
    const indexDdl: string[] = [];
    const fkDdl: string[] = [];

    for (const tableName of tableNames) {
      const createSql = String(master.find((r) => r.name === tableName)?.sql ?? "");
      if (/WITHOUT\s+ROWID/i.test(createSql)) {
        // Harmless for Postgres (no rowid concept); noted so the choice is visible.
      }
      const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as ColumnInfo[];
      const pkCols = columns
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);

      const pgColumns: PgColumn[] = columns.map((c) => {
        const key = `${tableName}.${c.name}`;
        const where = `table ${key}`;
        const isBoolean = BOOLEAN_COLUMNS.has(key);
        if (isBoolean) seenBooleans.add(key);
        const pgType = attempt<PgType>(() => mapType(c.type, isBoolean, where), "TEXT");
        const identity =
          pkCols.length === 1 && pkCols[0] === c.name && c.type.toUpperCase() === "INTEGER";
        const columnDef = new RegExp(
          `["\`\\[]?${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["\`\\]]?\\s+[^,]*COLLATE\\s+NOCASE`,
          "i"
        );
        if (columnDef.test(createSql)) nocaseColumns.push(key);
        return {
          name: c.name,
          pgType,
          notNull: c.notnull === 1 || (c.pk > 0 && pkCols.length === 1 && !identity),
          defaultSql: identity ? null : attempt(() => mapDefault(c.dflt_value, pgType, where), null),
          identity,
        };
      });

      const uniques: string[][] = [];
      const indexList = db.prepare(`PRAGMA index_list("${tableName}")`).all() as Row[];
      for (const index of indexList.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        const indexName = String(index.name);
        const origin = String(index.origin);
        if (origin === "pk") continue;

        const xinfo = (db.prepare(`PRAGMA index_xinfo("${indexName}")`).all() as Row[])
          .filter((x) => Number(x.key) === 1)
          .sort((a, b) => Number(a.seqno) - Number(b.seqno));
        const hasExpression = xinfo.some((x) => Number(x.cid) === -2);
        const indexSql = String(
          master.find((r) => r.type === "index" && r.name === indexName)?.sql ?? ""
        );

        if (origin === "u") {
          if (hasExpression) {
            problems.push(`${tableName}: expression UNIQUE constraint ${indexName}`);
            continue;
          }
          uniques.push(xinfo.map((x) => String(x.name)));
          continue;
        }

        if (INDEX_OVERRIDES.has(indexName)) {
          usedIndexOverrides.add(indexName);
          const override = INDEX_OVERRIDES.get(indexName);
          if (override) indexDdl.push(override.trim().replace(/;?$/, ";"));
          continue;
        }

        const partial = Number(index.partial) === 1;
        let whereClause = "";
        if (partial) {
          const match = /\bWHERE\b([\s\S]*)$/i.exec(indexSql);
          const predicate = match?.[1].trim() ?? "";
          if (!predicate || /\w\s*\(/.test(predicate) || !/^[\w\s."'=<>!()-]+$/.test(predicate)) {
            problems.push(
              `index ${indexName}: partial predicate needs an INDEX_OVERRIDES entry: ${predicate.replace(/\s+/g, " ")}`
            );
            continue;
          }
          const booleanCols = pgColumns.filter((c) => c.pgType === "BOOLEAN").map((c) => c.name);
          let translated = predicate;
          for (const col of booleanCols) {
            translated = translated
              .replace(new RegExp(`\\b${col}\\s*=\\s*1\\b`, "g"), `${col} = TRUE`)
              .replace(new RegExp(`\\b${col}\\s*=\\s*0\\b`, "g"), `${col} = FALSE`);
          }
          whereClause = ` WHERE ${translated.replace(/\s+/g, " ")}`;
        }
        if (hasExpression) {
          problems.push(
            `index ${indexName}: expression index needs an INDEX_OVERRIDES entry: ${indexSql.replace(/\s+/g, " ")}`
          );
          continue;
        }

        const cols = xinfo
          .map((x) => `${quoteIdent(String(x.name))}${Number(x.desc) === 1 ? " DESC" : ""}`)
          .join(", ");
        const unique = Number(index.unique) === 1 ? "UNIQUE " : "";
        indexDdl.push(
          `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(indexName)} ON ${quoteIdent(tableName)} (${cols})${whereClause};`
        );
      }

      const fks = db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as Row[];
      const fkGroups = new Map<number, Row[]>();
      for (const fk of fks) {
        const id = Number(fk.id);
        fkGroups.set(id, [...(fkGroups.get(id) ?? []), fk]);
      }
      for (const group of [...fkGroups.values()]) {
        group.sort((a, b) => Number(a.seq) - Number(b.seq));
        const target = String(group[0].table);
        if (!tableSet.has(target)) {
          problems.push(`${tableName}: foreign key to excluded/missing table ${target}`);
          continue;
        }
        const from = group.map((g) => String(g.from));
        const to = group.map((g) => String(g.to ?? ""));
        const constraint = `fk_${tableName}_${from.join("_")}`;
        const onDelete = String(group[0].on_delete ?? "NO ACTION");
        const onUpdate = String(group[0].on_update ?? "NO ACTION");
        fkDdl.push(
          [
            "DO $$ BEGIN",
            `  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraint}') THEN`,
            `    ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(constraint)}`,
            `      FOREIGN KEY (${from.map(quoteIdent).join(", ")}) REFERENCES ${quoteIdent(target)}` +
              (to.every(Boolean) ? ` (${to.map(quoteIdent).join(", ")})` : ""),
            `      ON DELETE ${onDelete} ON UPDATE ${onUpdate};`,
            "  END IF;",
            "END $$;",
          ].join("\n")
        );
      }

      tables.push({ name: tableName, columns: pgColumns, primaryKey: pkCols, uniques });
    }

    if (problems.length > 0) {
      throw new Error(`Cannot translate the SQLite schema:\n  - ${problems.join("\n  - ")}`);
    }

    const missingBooleans = [...BOOLEAN_COLUMNS].filter((key) => !seenBooleans.has(key));
    if (missingBooleans.length > 0) {
      throw new Error(`schemaOverrides: BOOLEAN_COLUMNS lists missing columns: ${missingBooleans}`);
    }
    const unusedOverrides = [...INDEX_OVERRIDES.keys()].filter((k) => !usedIndexOverrides.has(k));
    if (unusedOverrides.length > 0) {
      throw new Error(`schemaOverrides: stale INDEX_OVERRIDES entries: ${unusedOverrides}`);
    }

    return {
      sql: renderSqlModule(tables, indexDdl, fkDdl, nocaseColumns),
      ts: renderSchemaModule(tables),
    };
  } finally {
    core.resetDbInstance();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function renderTable(table: PgTable): string {
  const lines = table.columns.map((c) => {
    if (c.identity) return `  ${quoteIdent(c.name)} BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
    let line = `  ${quoteIdent(c.name)} ${c.pgType}`;
    if (c.notNull) line += " NOT NULL";
    if (c.defaultSql !== null) line += ` DEFAULT ${c.defaultSql}`;
    return line;
  });
  const hasIdentity = table.columns.some((c) => c.identity);
  if (table.primaryKey.length > 0 && !hasIdentity) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
  }
  for (const unique of table.uniques) {
    lines.push(`  UNIQUE (${unique.map(quoteIdent).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n${lines.join(",\n")}\n);`;
}

function renderSqlModule(
  tables: PgTable[],
  indexDdl: string[],
  fkDdl: string[],
  nocaseColumns: string[]
): string {
  const body = [
    ...tables.map(renderTable),
    ...indexDdl.sort(),
    ...fkDdl,
  ].join("\n\n");
  // Embedded in a String.raw template: a backtick or "${" would end or interpolate it.
  if (body.includes("`") || body.includes("${")) {
    throw new Error("Generated DDL contains a backtick or ${ and cannot be embedded verbatim");
  }
  const nocaseNote =
    nocaseColumns.length > 0
      ? [
          " *",
          " * COLLATE NOCASE columns (case-insensitive in SQLite, case-SENSITIVE here —",
          " * Postgres repositories must compare with lower() where the domain relies on it):",
          ...nocaseColumns.sort().map((c) => ` *   - ${c}`),
        ]
      : [];
  return [
    "/**",
    " * AUTO-GENERATED by scripts/db/gen-postgres-schema.ts — do not edit by hand.",
    " * Regenerate: npm run gen:postgres-schema · Drift gate: npm run check:postgres-schema",
    " *",
    ` * Greenfield DDL for the opt-in Postgres backend: ${tables.length} tables, ${indexDdl.length} indexes,`,
    ` * ${fkDdl.length} foreign keys, introspected from the fully-migrated SQLite schema.`,
    " * Idempotent (IF NOT EXISTS); applied by bootstrap.ts under an advisory lock.",
    ...nocaseNote,
    " */",
    "export const POSTGRES_BOOTSTRAP_SQL = String.raw`",
    body,
    "`;",
    "",
  ].join("\n");
}

function renderSchemaModule(tables: PgTable[]): string {
  const interfaces = tables.map((table) => {
    const fields = table.columns.map((c) => {
      const base = tsType(c.pgType);
      const nullable = !c.notNull && !c.identity;
      const valueType = nullable ? `${base} | null` : base;
      const generated = c.identity || c.defaultSql !== null;
      return `  ${tsKey(c.name)}: ${generated ? `Generated<${valueType}>` : valueType};`;
    });
    return `export interface ${pascalCase(table.name)}Table {\n${fields.join("\n")}\n}`;
  });
  const dbFields = tables.map((t) => `  ${tsKey(t.name)}: ${pascalCase(t.name)}Table;`);
  return [
    "/**",
    " * AUTO-GENERATED by scripts/db/gen-postgres-schema.ts — do not edit by hand.",
    " * Kysely types for the opt-in Postgres backend. BIGINT columns are parsed to",
    " * numbers by the pool (dialect.ts); BOOLEAN columns come from schemaOverrides.ts.",
    " */",
    'import type { Generated } from "kysely";',
    "",
    ...interfaces.flatMap((i) => [i, ""]),
    "export interface Database {",
    ...dbFields,
    "}",
    "",
    `export const POSTGRES_TABLES = [\n${tables.map((t) => `  ${JSON.stringify(t.name)},`).join("\n")}\n] as const;`,
    "",
  ].join("\n");
}

async function main() {
  const check = process.argv.includes("--check");
  const { sql, ts } = await generate();
  const outputs: Array<[string, string]> = [
    [OUT_SQL, sql],
    [OUT_TS, ts],
  ];

  if (check) {
    const stale = outputs.filter(
      ([file, content]) => !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content
    );
    if (stale.length > 0) {
      console.error("❌ Postgres schema is stale relative to the SQLite migrations:");
      for (const [file] of stale) console.error(`  - ${path.relative(REPO_ROOT, file)}`);
      console.error("Run `npm run gen:postgres-schema` and commit the result.");
      process.exit(1);
    }
    console.log("✅ Postgres schema matches the SQLite migrations.");
    return;
  }

  for (const [file, content] of outputs) fs.writeFileSync(file, content);
  console.log(`Wrote ${outputs.map(([f]) => path.relative(REPO_ROOT, f)).join(", ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
  process.exit(0);
}
