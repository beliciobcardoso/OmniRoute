import { sql, type Kysely } from "kysely";

import { POSTGRES_BOOTSTRAP_SQL } from "./bootstrapSql";
import type { Database } from "./schema";

/**
 * Fixed key for pg_advisory_xact_lock. Any stable 64-bit int works; it is
 * scoped to schema bootstrap only.
 */
const BOOTSTRAP_ADVISORY_LOCK_KEY = 872234871;

const MAX_BOOTSTRAP_ATTEMPTS = 3;

/**
 * code 23505 = unique_violation on the pg_type catalog. Even with the
 * advisory lock, two sessions can race before either takes the lock under
 * high concurrency (many replicas or test files cold-starting against one
 * instance). The failed transaction rolled back entirely, so a retry either
 * takes the lock cleanly or sees every table already committed.
 */
function isTransientCatalogRace(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

/**
 * Applies the generated greenfield schema (bootstrapSql.ts — CREATE ... IF
 * NOT EXISTS, idempotent). It is not a replay of the SQLite migrations: the
 * Postgres backend has no pre-existing installs to migrate incrementally.
 * The DDL is embedded as a TS string (not read from a .sql file) so it ships
 * in the standalone build without file-tracing rules. Regenerate with
 * `npm run gen:postgres-schema` after adding a SQLite migration;
 * `npm run check:postgres-schema` fails on drift.
 *
 * Runs in one transaction under pg_advisory_xact_lock so concurrent
 * cold starts serialize instead of colliding on the catalog. The lock is
 * released automatically at commit/rollback.
 */
export async function runPostgresBootstrap(db: Kysely<Database>): Promise<void> {
  for (let attempt = 1; attempt <= MAX_BOOTSTRAP_ATTEMPTS; attempt++) {
    try {
      await db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`.execute(trx);
        await sql.raw(POSTGRES_BOOTSTRAP_SQL).execute(trx);
      });
      return;
    } catch (err) {
      if (attempt >= MAX_BOOTSTRAP_ATTEMPTS || !isTransientCatalogRace(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}
