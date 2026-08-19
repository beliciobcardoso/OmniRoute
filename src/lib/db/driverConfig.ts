import { z } from "zod";

/**
 * Resolves and validates the DB_DRIVER / DATABASE_URL contract.
 * "sqlite" is the default and the only driver supported by the Electron
 * build — see docs/architecture/POSTGRES_SUPPORT.md.
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
 * Throws a clear, fail-fast error at boot when DB_DRIVER=postgres is set
 * without a usable DATABASE_URL, instead of surfacing a confusing error
 * later from the first query.
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

  return { driver, databaseUrl };
}
