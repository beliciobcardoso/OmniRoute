import { Kysely } from "kysely";

import { resolveDbDriverConfig } from "../driverConfig";
import { runPostgresBootstrap } from "./bootstrap";
import { createPostgresDialect } from "./dialect";
import type { Database } from "./schema";

/**
 * Kysely client for the opt-in Postgres persistence backend.
 *
 * Only Postgres repository implementations (src/lib/db/repositories/postgres*)
 * and composition roots may use this — business code depends on repository
 * contracts in src/domain/persistence/, never on a dialect
 * (docs/architecture/persistence-backend-boundary.md). Enforced by
 * scripts/check/check-postgres-boundary.mjs.
 */
export class PostgresNotConfiguredError extends Error {}

let cachedDb: Kysely<Database> | null = null;
let bootstrapPromise: Promise<void> | null = null;

export function getPostgresDb(): Kysely<Database> {
  if (cachedDb) return cachedDb;

  const config = resolveDbDriverConfig();
  if (config.driver !== "postgres" || !config.databaseUrl) {
    throw new PostgresNotConfiguredError(
      "getPostgresDb() requires DB_DRIVER=postgres and DATABASE_URL."
    );
  }

  cachedDb = new Kysely<Database>({
    dialect: createPostgresDialect(config.databaseUrl),
  });
  return cachedDb;
}

/**
 * Creates every relational table (idempotent) on first use. Postgres
 * repositories await this before their first query; getPostgresDb() itself
 * stays a plain synchronous getter with no I/O side effects. A failed
 * bootstrap is not cached, so the next caller retries.
 */
export async function ensurePostgresBootstrap(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runPostgresBootstrap(getPostgresDb()).catch((err: unknown) => {
      bootstrapPromise = null;
      throw err;
    });
  }
  await bootstrapPromise;
}

/** Test-only: closes and clears the cached client so tests get a fresh instance. */
export async function resetPostgresDb(): Promise<void> {
  bootstrapPromise = null;
  if (cachedDb) {
    const db = cachedDb;
    cachedDb = null;
    await db.destroy();
  }
}
