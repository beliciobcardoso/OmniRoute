---
title: "PostgreSQL Support"
lastUpdated: 2026-08-19
---

# PostgreSQL Support (opt-in alternative backend)

**Status:** in progress (implementation plan: `_tasks/superpowers/plans/2026-08-19-postgres-adapter.md`)

## What this is

OmniRoute's default and only fully-supported database is **SQLite** (see main
`CLAUDE.md` → "Database"). This document tracks an **opt-in, experimental** second
backend: PostgreSQL, for self-hosted/server deployments that want a real external
database instead of the default file-based SQLite.

This is **not** a migration. SQLite is not being removed, deprecated, or made
second-class. There is no SQLite→Postgres data migration path, and none is planned —
the two backends are independent, and switching a running deployment from one to the
other means starting from an empty database.

See [`cluster-decisions.md`](./cluster-decisions.md) for why PostgreSQL was previously
rejected as a _required_ cluster sidecar, and why that decision doesn't block this
_optional_ backend.

## Scope

| Surface                   | SQLite (default)                  | Postgres (opt-in)                           |
| ------------------------- | --------------------------------- | ------------------------------------------- |
| Electron desktop build    | ✅ only option                    | ❌ not supported                            |
| Server / Docker / Coolify | ✅ default                        | ✅ opt-in via `DB_DRIVER=postgres`          |
| Relational domain tables  | file-based, WAL                   | `pg.Pool`, real connection pool             |
| Migrations                | `.sql` files, SQLite dialect      | dual-dialect (Kysely schema builder)        |
| Memory keyword search     | FTS5 virtual table                | `tsvector` + `GIN` index                    |
| Memory vector search      | `sqlite-vec` or Qdrant (optional) | **Qdrant required** — no `pgvector` support |

## Minimum supported version

**PostgreSQL 15+.** Chosen for native `gen_random_uuid()` (no `pgcrypto` extension
needed) and mature `MERGE`/`ON CONFLICT` support used to translate SQLite's
`INSERT OR IGNORE`/`INSERT OR REPLACE` patterns.

## Deployment topology: external instance by default

The expected setup is an **externally managed Postgres instance** — one already
running on the host/VPS (or a managed service), shared across whatever else lives
there, not something OmniRoute provisions or owns. OmniRoute only ever _connects_ to
it via `DATABASE_URL`; it never creates the server process, and there is no
lifecycle coupling between "OmniRoute is up" and "Postgres is up." Dev and prod use
the same pattern — point `DATABASE_URL` at whichever instance is appropriate for that
environment.

[`docker-compose.coolify.yaml`](../../docker-compose.coolify.yaml) — the file used
for this project's actual Coolify deployment — passes `DB_DRIVER`/`DATABASE_URL`
through to the `omniroute` service as optional Coolify environment variables, so an
operator can opt in from Coolify's env var UI without touching the compose file. It
does **not** define a Postgres container: the instance itself is expected to already
exist (Coolify makes it easy to run a separate Postgres resource on the same host/
project if one isn't already available elsewhere). `docker-compose.yml` (local dev)
and `docker-compose.prod.yml` intentionally do not reference Postgres at all — SQLite
is the only backend either of those has ever needed.

## Configuration

```bash
# Default — no change needed for existing installs.
DB_DRIVER=sqlite

# Opt-in Postgres backend.
DB_DRIVER=postgres
DATABASE_URL=postgres://user:password@host:5432/omniroute

# Required when DB_DRIVER=postgres, because sqlite-vec is unavailable:
QDRANT_HOST=...
QDRANT_PORT=...
```

Boot fails fast with a clear error if `DB_DRIVER=postgres` is set without a valid
`DATABASE_URL`, or without a reachable Qdrant configuration.

## Why Qdrant is mandatory in Postgres mode

SQLite mode gets local vector search "for free" via the `sqlite-vec` extension
(`src/lib/memory/vectorStore.ts`). There is no equivalent zero-dependency vector
extension bundled for Postgres in this project (`pgvector` was evaluated and rejected —
see `cluster-decisions.md` — due to ecosystem fragmentation and the extra operational
burden of managing a Postgres extension). Rather than half-support vectors in Postgres
mode, vector search is fully delegated to Qdrant (already an existing, independently
optional dependency — see `src/lib/memory/qdrant.ts`), and keyword search uses
Postgres's native `tsvector`/`GIN` index. The two are combined with the same
Reciprocal Rank Fusion (RRF) approach used today for the SQLite `hybrid-rrf` tier.

## Non-goals

- SQLite → Postgres data migration.
- Postgres support in the Electron build.
- `pgvector` as an alternative to Qdrant.
- Support for database engines other than SQLite and PostgreSQL.

## Known gaps / follow-ups

Deferred module conversions, out-of-scope-by-design decisions, and test-suite
gaps found while validating the conversion: see
[`POSTGRES_TECH_DEBT.md`](./POSTGRES_TECH_DEBT.md).

## Implementation plan

Full phased plan (fundação, adapters, migrações, módulos de domínio, memória, testes,
docs, rollout): `_tasks/superpowers/plans/2026-08-19-postgres-adapter.md`.
