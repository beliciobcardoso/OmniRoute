import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";

import {
  ensurePostgresBootstrap,
  getPostgresDb,
  resetPostgresDb,
} from "../../../src/lib/db/postgres/client.ts";
import { POSTGRES_TABLES } from "../../../src/lib/db/postgres/schema.ts";

/**
 * Requires a real Postgres 15+ at DATABASE_URL, e.g.:
 *   docker run -d --rm --name omniroute-pg-test -e POSTGRES_USER=omniroute \
 *     -e POSTGRES_PASSWORD=omniroute -e POSTGRES_DB=omniroute -p 127.0.0.1:55440:5432 postgres:16-alpine
 *   DB_DRIVER=postgres OMNIROUTE_POSTGRES_PARTIAL_BACKEND=1 DATABASE_URL=postgres://omniroute:omniroute@127.0.0.1:55440/omniroute \
 *     node --import tsx/esm --test tests/integration/postgres/*.test.ts
 * Runs in CI as the `test-postgres-backend` job; skipped when DATABASE_URL is unset.
 */
const SKIP = !process.env.DATABASE_URL;

async function withFreshSchema(fn: () => Promise<void>) {
  process.env.DB_DRIVER = "postgres";
  process.env.OMNIROUTE_POSTGRES_PARTIAL_BACKEND = "1";
  await resetPostgresDb();
  const db = getPostgresDb();
  await sql`DROP SCHEMA public CASCADE`.execute(db);
  await sql`CREATE SCHEMA public`.execute(db);
  try {
    await fn();
  } finally {
    await resetPostgresDb();
  }
}

async function countGeneratedTables(): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${[...POSTGRES_TABLES]})
  `.execute(getPostgresDb());
  return result.rows[0]?.count ?? 0;
}

test("bootstrap creates every generated table and is idempotent", { skip: SKIP }, async () => {
  await withFreshSchema(async () => {
    await ensurePostgresBootstrap();
    assert.equal(await countGeneratedTables(), POSTGRES_TABLES.length);

    await resetPostgresDb();
    await ensurePostgresBootstrap();
    assert.equal(await countGeneratedTables(), POSTGRES_TABLES.length);
  });
});

test(
  "concurrent cold starts serialize instead of colliding on the catalog",
  { skip: SKIP },
  async () => {
    await withFreshSchema(async () => {
      const { runPostgresBootstrap } = await import("../../../src/lib/db/postgres/bootstrap.ts");
      const { Kysely } = await import("kysely");
      const { createPostgresDialect } = await import("../../../src/lib/db/postgres/dialect.ts");
      const clients = Array.from(
        { length: 4 },
        () => new Kysely({ dialect: createPostgresDialect(process.env.DATABASE_URL as string) })
      );
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-less clients
        await Promise.all(clients.map((client) => runPostgresBootstrap(client as any)));
      } finally {
        await Promise.all(clients.map((client) => client.destroy()));
      }
      assert.equal(await countGeneratedTables(), POSTGRES_TABLES.length);
    });
  }
);

test("defaults match the SQLite value shapes", { skip: SKIP }, async () => {
  await withFreshSchema(async () => {
    await ensurePostgresBootstrap();
    const db = getPostgresDb();
    await sql`INSERT INTO combos (id, name, data, created_at, updated_at)
              VALUES ('c1', 'n1', '{}', 'x', 'x')`.execute(db);
    const combo = await db
      .selectFrom("combos")
      .selectAll()
      .where("id", "=", "c1")
      .executeTakeFirstOrThrow();
    assert.equal(combo.sort_order, 0, "BIGINT comes back as a number");
    assert.equal(combo.context_cache_protection, false, "boolean override applied");

    await sql`INSERT INTO _omniroute_migrations (version, name) VALUES ('v', 'n')`.execute(db);
    const migration = await db
      .selectFrom("_omniroute_migrations")
      .select("applied_at")
      .executeTakeFirstOrThrow();
    assert.match(
      migration.applied_at,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      "CURRENT_TIMESTAMP text format"
    );
  });
});
