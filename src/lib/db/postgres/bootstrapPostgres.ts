import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely/types";

const BOOTSTRAP_SQL_PATH = fileURLToPath(new URL("./bootstrap.sql", import.meta.url));

/**
 * Arbitrary fixed key for pg_advisory_xact_lock — any 64-bit int works, it
 * just needs to be stable and unlikely to collide with another advisory
 * lock this codebase might take. Scoped to this one purpose only.
 */
const BOOTSTRAP_ADVISORY_LOCK_KEY = 872234871;

/**
 * Creates all 104 relational tables (idempotent — CREATE TABLE IF NOT EXISTS)
 * for the opt-in Postgres backend. This is a single greenfield bootstrap, not
 * a replay of the 119 SQLite migrations — see
 * docs/architecture/POSTGRES_SUPPORT.md and
 * _tasks/superpowers/plans/2026-08-19-postgres-adapter.md (Fase 4).
 *
 * FTS5/sqlite-vec shadow tables are intentionally not created here (Fase 6:
 * tsvector + mandatory Qdrant in Postgres mode).
 *
 * Runs inside a single transaction, guarded by a `pg_advisory_xact_lock`.
 * `CREATE TABLE IF NOT EXISTS` alone is NOT safe against two concurrent
 * sessions bootstrapping at the same time — both transactions can pass the
 * "does it exist?" check before either commits, and the second one then
 * fails with a duplicate-key error on the pg_type catalog (reproduced with
 * two real concurrent processes against the same instance — the exact
 * scenario multiple OmniRoute replicas hit on simultaneous cold start). The
 * advisory lock serializes the whole bootstrap across sessions: the second
 * caller blocks until the first commits, then correctly sees every table
 * already there and no-ops. `pg_advisory_xact_lock` auto-releases at
 * transaction end (commit or rollback) — no separate unlock call needed.
 */
export async function runPostgresBootstrap(db: Kysely<Database>): Promise<void> {
  const bootstrapSql = readFileSync(BOOTSTRAP_SQL_PATH, "utf8");
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`.execute(trx);
    await sql.raw(bootstrapSql).execute(trx);
  });
}
