import { Kysely } from "kysely";

import { resolveDbDriverConfig } from "../driverConfig";
import { createPostgresDialect } from "./dialect";
import { runPostgresBootstrap } from "../postgres/bootstrapPostgres";
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
let bootstrapPromise: Promise<void> | null = null;

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

/**
 * Creates all 104 relational tables (idempotent) if they don't already
 * exist. Callers that need the schema to exist — a converted domain module,
 * or app startup in Postgres mode — must call this explicitly; getKyselyDb()
 * itself stays a plain, synchronous client getter with no I/O side effects.
 */
export async function ensurePostgresBootstrap(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runPostgresBootstrap(getKyselyDb());
  }
  await bootstrapPromise;
}

/** Test-only: closes and clears the cached client so tests get a fresh instance. */
export async function resetKyselyDb(): Promise<void> {
  bootstrapPromise = null;
  if (cachedDb) {
    await cachedDb.destroy();
    cachedDb = null;
  }
}
