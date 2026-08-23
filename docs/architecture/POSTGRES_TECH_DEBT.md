---
title: "PostgreSQL Dual-Dialect — Technical Debt"
lastUpdated: 2026-08-23
---

# PostgreSQL Dual-Dialect — Technical Debt

Tracks known gaps and follow-ups from the ongoing SQLite/Postgres dual-dialect
conversion (see [`POSTGRES_SUPPORT.md`](./POSTGRES_SUPPORT.md) for the feature
overview and `_tasks/superpowers/plans/2026-08-19-postgres-adapter.md` for the
phased plan). This is a living list — update it whenever a deferred item is
picked up or a new gap is found, don't let it go stale.

## Deferred module conversions

### `src/lib/db/models/compat.ts` — hot-path sync reads

`getModelNormalizeToolCallId`, `getModelPreserveOpenAIDeveloperRole`,
`getModelIsHidden`, `getHiddenModelsByProvider`, `getModelIsDeleted`,
`setModelIsHidden`, `getModelUpstreamExtraHeaders` are called synchronously via
object-spread deep in `chatCore.ts` / `upstreamExecuteHeaders.ts` / `combo.ts`'s
per-request hot path. Making them `async` would force `await` through call sites
that currently can't tolerate it without a larger refactor.

**Needed before conversion:** a caching layer (in-memory, refreshed on write)
sitting in front of the Postgres reads, mirroring the pattern already used by
`reasoningCache.ts`, so the hot path stays synchronous against a warm cache
instead of hitting Postgres per request. No such cache exists yet for this
module — this is net-new design work, not a small tweak.

**Current behavior under Postgres:** `replaceSyncedAvailableModelsForConnection`'s
`getModelIsDeleted(...)` filter call only sees SQLite-side state (documented
inline in `models.ts`) — a real functional gap, not just a style one.

### `src/lib/usage/aggregateHistory.ts` — done, but watch `rollupDailyUsage` / `rollupHourlyQuota`

`rollupUsageHistoryBeforeDate` (used by `cleanup.ts`'s `cleanupUsageHistory`) is
converted and tested. `rollupDailyUsage` / `rollupHourlyQuota` are also converted,
but their only callers are `src/scripts/backfillAggregation.ts` (an offline
backfill script) and their own unit test — they've never been exercised through
a real running server. Low risk, but worth a manual run against a Postgres
instance the first time someone actually invokes the backfill script in that mode.

### `src/lib/db/jsonMigration.ts` — legacy JSON backup import, Postgres-side caveats

- Uses raw `sql` template literals with `OVERRIDING SYSTEM VALUE` for
  `usage_history` / `domain_cost_history` inserts, because Kysely 0.28.17 has no
  builder method for that clause. If Kysely ever adds
  `.overridingSystemValue()`, switch these two blocks to the builder API instead
  of raw SQL for consistency with the rest of the file.
- Not covered by any production traffic — it's an admin-triggered, rarely-used
  "restore from legacy backup" feature. The Postgres path
  (`tests/integration/postgres/jsonMigration.test.ts`) covers the mechanics but
  has never been run against a real user-supplied backup file on a Postgres
  deployment.

## Explicitly out of scope (by design, not oversight)

These will likely never be converted — documented here so nobody re-opens them
as "missed" modules:

- `src/lib/db/domainState.ts` — circuit breaker constructor can't be made async
  (architectural constraint).
- `src/lib/db/optimizationSettings.ts`, `stats.ts`, `healthCheck.ts`,
  `schemaColumns.ts`, `vacuumScheduler.ts`, `backup.ts`, `migrationRunner.ts`,
  `core.ts` — SQLite-engine-specific (PRAGMA tuning, `VACUUM`, `sqlite_master`
  introspection, file-based backup). No Postgres equivalent via this code path;
  Postgres bootstrap/maintenance goes through `kysely/client.ts` +
  `postgres/bootstrap.sql` instead.
- `src/lib/memory/*` vector search — Qdrant-only under Postgres, no `pgvector`
  support (see `POSTGRES_SUPPORT.md` → "Why Qdrant is mandatory").
- `src/lib/db/discovery.ts` — dead code, superseded by the already-converted
  `discoveryResults.ts` (not re-exported from `localDb.ts`, not imported by any
  route). Candidate for deletion in a separate cleanup pass, not a conversion
  target.
- `src/lib/db/usageLogs.ts` — queries a `usage_logs` table that does not exist
  in either the SQLite or Postgres schema. Already broken/orphaned in
  production regardless of dialect; fixing it is a separate bug-fix task, not
  part of dual-dialect conversion.

## Test-suite gaps found 2026-08-23 (not caused by the conversion work, but block reliable local re-runs)

While validating the full `tests/integration/postgres/*.test.ts` suite locally
against a persistent Postgres instance (as opposed to CI's fresh
`postgres:16-alpine` container per run), two pre-existing tests were found to
have **no cleanup step**, so they only pass on a virgin table and fail on any
second run against the same database:

- `tests/integration/postgres/middleware.test.ts` — leaves rows in
  `middleware_logs`.
- `tests/integration/postgres/obsidian.test.ts` — leaves rows in `key_value`
  under the `obsidian` namespace.

**Why this hasn't been caught by CI:** the CI job spins up a brand-new Postgres
container per run, so every run is effectively "first run" and this never
surfaces there. It only matters for local iterative development against a
long-lived test database.

**Fix:** add a `finally` block to both tests that deletes their own fixture
rows by id/namespace, following the pattern used by every Postgres integration
test added during the 2026-08 conversion pass (e.g.
`tests/integration/postgres/cleanup.test.ts`, `usageAnalytics.test.ts`).

Separately, running the **entire** 81-file suite with default `node --test`
concurrency showed one flaky failure in
`tests/integration/postgres/aggregateHistory.test.ts` that did not reproduce
when run in isolation or with `--test-concurrency=1`. Root cause not
conclusively identified, but the likely explanation is cross-file interference:
none of the 81 Postgres integration test files run in an isolated
schema/transaction — they all share one live database, so a broadly-scoped
statement in one file (an unfiltered `DELETE`, a `resetKyselyDb()` call) can
race with another file's fixture setup when Node's test runner executes
multiple files concurrently (its default). This is a structural gap in the
whole Postgres integration suite, not specific to any one file.

**Possible fixes (not yet attempted, needs a decision before investing time):**

1. Force serial execution in CI too (`node --test --test-concurrency=1
tests/integration/postgres/*.test.ts`) — simplest, costs wall-clock time.
2. Give each test file a unique key/id prefix and scope every cleanup to that
   prefix (partially already true for tests added in the 2026-08 pass; older
   files like the two above don't follow this consistently).
3. Wrap each test in its own Postgres transaction that gets rolled back at the
   end instead of doing manual `DELETE`-based cleanup — would need every
   `src/lib/db/*.ts` function under test to accept an injectable
   transaction/connection, which most don't today.

## How to keep this file useful

- When picking up an item here, move it out (delete the section) once done —
  don't mark it "done" in place, that just grows the file forever.
- When a new "not going to convert this" decision is made, add it to the
  out-of-scope list with the actual reason, not just "later."
- When a new gap is found during any Postgres validation pass, add it here
  before moving on — this file exists specifically so those findings don't
  live only in a chat transcript.
