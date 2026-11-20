import { PostgresDialect } from "kysely";
import pg from "pg";

/**
 * Postgres OID for INT8 / BIGINT. node-postgres returns it as a string by
 * default to avoid precision loss above 2^53. Every BIGINT column in the
 * generated schema mirrors a SQLite INTEGER (timestamps in ms, counters,
 * identity ids), all far below Number.MAX_SAFE_INTEGER, so the Postgres
 * repositories get plain numbers — the same shape the SQLite repositories
 * return. The parser is scoped to this pool, not installed globally.
 */
const INT8_OID = 20;

function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`BIGINT value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
}

const poolTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === INT8_OID && format !== "binary") return parseInt8;
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * Builds a Postgres Kysely dialect from a connection string. `pg.Pool`
 * connects lazily (no network I/O happens here), so this is safe to call
 * eagerly and cheap to unit test.
 */
export function createPostgresDialect(databaseUrl: string): PostgresDialect {
  return new PostgresDialect({
    pool: new pg.Pool({ connectionString: databaseUrl, types: poolTypes }),
  });
}

export const __testing = { parseInt8, poolTypes };
