import { Kysely } from "kysely";

import { resolveDbDriverConfig } from "../driverConfig";
import { createPostgresDialect } from "./dialect";
import type { Database } from "./types";

/**
 * Kysely is only wired up for the `postgres` driver so far. SQLite domain
 * modules still talk to src/lib/db/core.ts::getDbInstance() directly and
 * have not been converted yet (Fase 5 of the implementation plan) — calling
 * this with DB_DRIVER=sqlite throws rather than silently returning a client
 * that doesn't actually back anything.
 */
export class KyselyNotAvailableError extends Error {}

let cachedDb: Kysely<Database> | null = null;

export function getKyselyDb(): Kysely<Database> {
  if (cachedDb) return cachedDb;

  const config = resolveDbDriverConfig();
  if (config.driver !== "postgres" || !config.databaseUrl) {
    throw new KyselyNotAvailableError(
      "getKyselyDb() requires DB_DRIVER=postgres — SQLite domain modules " +
        "still use src/lib/db/core.ts::getDbInstance() directly."
    );
  }

  cachedDb = new Kysely<Database>({
    dialect: createPostgresDialect(config.databaseUrl),
  });
  return cachedDb;
}

/** Test-only: closes and clears the cached client so tests get a fresh instance. */
export async function resetKyselyDb(): Promise<void> {
  if (cachedDb) {
    await cachedDb.destroy();
    cachedDb = null;
  }
}
