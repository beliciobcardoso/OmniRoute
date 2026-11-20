import { z } from "zod";

/**
 * Resolves and validates the DB_DRIVER / DATABASE_URL contract for the
 * persistence backend selected at composition-root level
 * (see docs/architecture/persistence-backend-boundary.md).
 *
 * "sqlite" is the default and the only backend supported by the Electron
 * build. "postgres" is opt-in and experimental — see
 * docs/architecture/POSTGRES_SUPPORT.md.
 *
 * This selects the *persistence backend*. It is unrelated to
 * src/lib/db/adapters/driverFactory.ts, which picks a SQLite *runtime*
 * (better-sqlite3 / node:sqlite / bun:sqlite / sql.js).
 */

const dbDriverSchema = z.enum(["sqlite", "postgres"]);

export type DbDriver = z.infer<typeof dbDriverSchema>;

export interface DbDriverConfig {
  driver: DbDriver;
  databaseUrl: string | null;
}

export class DbDriverConfigError extends Error {}

function readDbDriver(): DbDriver {
  const raw = process.env.DB_DRIVER?.trim();
  if (!raw) return "sqlite";

  const parsed = dbDriverSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DbDriverConfigError(`Invalid DB_DRIVER "${raw}" — expected "sqlite" or "postgres".`);
  }
  return parsed.data;
}

/**
 * Domains are ported to Postgres one slice at a time. Until every domain is
 * ported, DB_DRIVER=postgres runs a *partial* backend: ported domains read and
 * write Postgres while the rest stay in SQLite, cross-domain writes are not
 * atomic, and code that still reads ported tables through raw SQLite SQL sees
 * an empty table. Booting that by accident must not be possible, so it needs
 * an explicit acknowledgement. Remove this gate once the port is complete.
 */
export const POSTGRES_PARTIAL_ACK_ENV = "OMNIROUTE_POSTGRES_PARTIAL_BACKEND";

/**
 * Throws a clear, fail-fast error at boot when DB_DRIVER=postgres is set
 * without a usable DATABASE_URL or without acknowledging the partial backend,
 * instead of surfacing a confusing error later from the first query.
 */
export function resolveDbDriverConfig(): DbDriverConfig {
  const driver = readDbDriver();

  if (driver === "sqlite") {
    return { driver, databaseUrl: null };
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new DbDriverConfigError(
      "DB_DRIVER=postgres requires DATABASE_URL to be set " +
        "(e.g. postgres://user:password@host:5432/omniroute)."
    );
  }

  if (process.env[POSTGRES_PARTIAL_ACK_ENV]?.trim() !== "1") {
    throw new DbDriverConfigError(
      `DB_DRIVER=postgres is a partial, experimental backend (only some domains are ported). ` +
        `Set ${POSTGRES_PARTIAL_ACK_ENV}=1 to acknowledge it; see docs/architecture/POSTGRES_SUPPORT.md.`
    );
  }

  return { driver, databaseUrl };
}
