/**
 * Regression guard: the Arena ELO initial sync must not outlive `register()`.
 *
 * Bug: `startPeriodicSync()` dropped the initial-sync promise, and instrumentation
 * awaited only `initArenaEloSync()` (which merely schedules). The sync writes model
 * intelligence rows through better-sqlite3, so when Next.js tore the `register()`
 * context down mid-sync the native `Statement` finalizers ran against a destroyed
 * `node::Environment`:
 *
 *   Assertion failed: (env) != nullptr → SIGABRT
 *
 * Observed on Coolify after the live-WS half was fixed: boots that logged
 * "Initial sync complete" survived; boots that did not, aborted.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

test("arenaEloSync exposes the initial-sync promise", async () => {
  const mod = await import("../../src/lib/arenaEloSync.ts");

  assert.equal(
    typeof mod.getArenaInitialSyncPromise,
    "function",
    "arenaEloSync must expose getArenaInitialSyncPromise() so the caller can await it"
  );
  assert.equal(
    mod.getArenaInitialSyncPromise(),
    undefined,
    "no initial-sync promise before startPeriodicSync() runs"
  );
});

test("startPeriodicSync captures the initial sync instead of dropping it", () => {
  const src = readFileSync(join(REPO_ROOT, "src/lib/arenaEloSync.ts"), "utf8");

  assert.match(
    src,
    /initialSyncPromise\s*=\s*syncArenaElo\(\)/,
    "the initial sync must be captured in initialSyncPromise — a bare syncArenaElo() " +
      "lets SQLite writes outlive the caller's context"
  );
});

test("instrumentation awaits the Arena initial sync before finishing register()", () => {
  const src = readFileSync(join(REPO_ROOT, "src/instrumentation-node.ts"), "utf8");

  assert.match(
    src,
    /await \(getArenaInitialSyncPromise\(\) \?\? Promise\.resolve\(\)\)/,
    "instrumentation must await getArenaInitialSyncPromise(); awaiting only " +
      "initArenaEloSync() returns while the sync is still writing to SQLite"
  );
});
