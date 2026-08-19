import type { ColumnType, Generated } from "kysely";

/**
 * Dual-dialect (SQLite + Postgres) schema, modeled incrementally as domain
 * modules are converted from raw SQL to Kysely (see
 * _tasks/superpowers/plans/2026-08-19-postgres-adapter.md, Fase 5).
 *
 * WORK IN PROGRESS: this interface intentionally does NOT cover every table
 * in src/lib/db/core.ts::SCHEMA_SQL yet (~100+ tables across 119
 * migrations). Only tables behind an already-converted module belong here.
 * Do not assume a table's absence means it doesn't exist in the database —
 * it means nothing has migrated it to Kysely yet.
 *
 * Booleans: SQLite has no native boolean type — columns like `no_log` are
 * declared `INTEGER NOT NULL DEFAULT 0` and store 0/1. Postgres uses a real
 * `boolean` column for the same field. `SqliteBoolean` models the SQLite
 * on-disk representation (0 | 1) while still letting callers write/compare
 * `true`/`false` — Kysely's `ColumnType<Select, Insert, Update>` lets the
 * TS-facing type differ from the storage type.
 */
export type SqliteBoolean = ColumnType<boolean, 0 | 1 | boolean, 0 | 1 | boolean>;

export interface KeyValueTable {
  namespace: string;
  key: string;
  value: string;
}

export interface CombosTable {
  id: string;
  name: string;
  data: string;
  sort_order: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface ApiKeysTable {
  id: string;
  name: string;
  key: string;
  machine_id: string | null;
  allowed_models: Generated<string | null>;
  no_log: SqliteBoolean;
  created_at: string;
}

export interface Database {
  key_value: KeyValueTable;
  combos: CombosTable;
  api_keys: ApiKeysTable;
}
