---
title: "PostgreSQL backend (opt-in)"
lastUpdated: 2026-11-20
---

# PostgreSQL backend (opt-in)

**Status:** partial. Domains move over one slice at a time, behind the repository contracts
defined by the [persistence boundary ADR](./persistence-backend-boundary.md). Not for production.

| Slice                       | Contract                                      | Postgres implementation                                                  |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Combos, model→combo mapping | `src/domain/persistence/comboRepositories.ts` | `src/lib/db/repositories/postgres{Combo,ModelComboMapping}Repository.ts` |
| Everything else             | —                                             | still SQLite                                                             |

SQLite stays the default and the only backend of the Electron build. Postgres is an opt-in,
server-mode backend for an **externally managed** Postgres 15+ instance. It is not a migration
path: a Postgres deployment starts from an empty database, and no SQLite → Postgres data copy
exists or is planned.

## Selecting the backend

| Variable                             | Values                         | Notes                                                            |
| ------------------------------------ | ------------------------------ | ---------------------------------------------------------------- |
| `DB_DRIVER`                          | `sqlite` (default), `postgres` | Any other value fails at boot.                                   |
| `DATABASE_URL`                       | `postgres://…`                 | Required when `DB_DRIVER=postgres`; else ignored.                |
| `OMNIROUTE_POSTGRES_PARTIAL_BACKEND` | `1`                            | Required with `DB_DRIVER=postgres` until every domain is ported. |

Validation lives in `src/lib/db/driverConfig.ts` (`resolveDbDriverConfig()`). It selects the
_persistence backend_ and is unrelated to `src/lib/db/adapters/driverFactory.ts`, which picks a
SQLite _runtime_.

Backend selection happens once per slice in its composition root — for combos,
`selectRoutingConfigRepositories()` in `src/lib/db/repositories/routingConfigRepositories.ts`.

## Partial backend: what does not hold yet

With `DB_DRIVER=postgres`, ported domains live in Postgres and the rest stays in SQLite:

- **Cross-store writes are not atomic.** Deleting or replace-importing combos commits in Postgres,
  then cleans the combo's proxy assignments, rotation cursor, LKGP rows, and API key grants in a
  separate SQLite transaction (`src/lib/db/repositories/comboDependents.ts`). A crash between the
  two leaves that state behind.
- **Raw SQLite readers of ported tables see an empty table.** For combos: the health-check combo
  repair (`src/lib/db/healthCheck.ts`), combo-level proxy resolution (`src/lib/db/settings.ts`),
  backups (`src/lib/db/backup.ts`), and the legacy JSON migration (`src/lib/db/jsonMigration.ts`).
  They move to their own repositories when their slice is ported.

The boot gate (`OMNIROUTE_POSTGRES_PARTIAL_BACKEND=1`) exists so this mode is never enabled by
accident. Remove it when the last domain is ported.

## Layout

All Postgres code is under `src/lib/db/postgres/`:

| File                 | Role                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `client.ts`          | `getPostgresDb()` Kysely client, `ensurePostgresBootstrap()` (idempotent, retried on failure).      |
| `dialect.ts`         | `pg.Pool` dialect. Parses `BIGINT` to `number` (pool-scoped) so rows match SQLite's shapes.         |
| `bootstrap.ts`       | Applies the DDL in one transaction under `pg_advisory_xact_lock` (safe for concurrent cold starts). |
| `bootstrapSql.ts`    | **Generated** greenfield DDL, embedded as a string so it ships in the standalone build.             |
| `schema.ts`          | **Generated** Kysely `Database` types and `POSTGRES_TABLES`.                                        |
| `schemaOverrides.ts` | Hand-maintained inputs: boolean columns, SQLite-only tables, untranslatable indexes.                |

## Schema generation

The Postgres schema is generated, never hand-edited:

```bash
npm run gen:postgres-schema     # after adding a SQLite migration
npm run check:postgres-schema   # CI gate: fails when the generated files are stale
```

`scripts/db/gen-postgres-schema.ts` builds a throwaway SQLite database through `core.ts` (every
migration), runs the lazy schema initializers that some modules execute on first use, and
introspects the result with `PRAGMA`. It refuses to guess: an unknown column type, default
expression, expression/partial index, or lazy `CREATE TABLE` / `ADD COLUMN` that it did not
reach fails the run until it is handled in `schemaOverrides.ts` or in the generator.

Type mapping: `INTEGER` → `BIGINT` (an `INTEGER PRIMARY KEY` becomes an identity column), `REAL`
→ `DOUBLE PRECISION`, `TEXT` → `TEXT`, `BLOB` → `BYTEA`, and columns listed in
`BOOLEAN_COLUMNS` → `BOOLEAN`. Current-timestamp column defaults keep SQLite's
`YYYY-MM-DD HH:MM:SS` UTC text format.

Known semantic difference: `COLLATE NOCASE` columns are case-sensitive in Postgres. The generated
DDL header lists them; a Postgres repository must compare with `lower()` where the domain relies
on case-insensitivity.

## Boundary

`npm run check:postgres-boundary` (`scripts/check/check-postgres-boundary.mjs`) fails when code
outside `src/lib/db/postgres/`, `src/lib/db/repositories/`, or `src/lib/db/driverConfig.ts`
imports `kysely`, `pg`, the Postgres client, or `driverConfig`, or calls `isPostgres()`. Business
code depends on a contract in `src/domain/persistence/`; backend selection happens once, in a
composition root under `src/lib/db/repositories/`.

## Tests

```bash
docker run -d --rm --name omniroute-pg-test -e POSTGRES_USER=omniroute \
  -e POSTGRES_PASSWORD=omniroute -e POSTGRES_DB=omniroute -p 127.0.0.1:55440:5432 postgres:16-alpine
DB_DRIVER=postgres OMNIROUTE_POSTGRES_PARTIAL_BACKEND=1 \
  DATABASE_URL=postgres://omniroute:omniroute@127.0.0.1:55440/omniroute npm run test:postgres
```

`tests/integration/postgres/*.test.ts` skip when `DATABASE_URL` is unset. Each ported slice runs
the same conformance suite as its SQLite repository (for combos,
`tests/helpers/persistence/comboRepositoryConformance.ts`). CI runs them in the
`test-postgres-backend` job against a `postgres:16-alpine` service container.
