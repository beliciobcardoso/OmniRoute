import { PostgresDialect } from "kysely";
import { Pool } from "pg";

/**
 * Builds a Postgres Kysely dialect from a connection string. `pg.Pool`
 * connects lazily (no network I/O happens here), so this is safe to call
 * eagerly and cheap to unit test.
 */
export function createPostgresDialect(databaseUrl: string): PostgresDialect {
  return new PostgresDialect({
    pool: new Pool({ connectionString: databaseUrl }),
  });
}
