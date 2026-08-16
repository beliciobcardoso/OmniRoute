/**
 * No-op SQLite adapter used during the Next.js production build phase.
 *
 * Why this exists: `next build` spawns N worker processes to collect page data.
 * Each worker imports the route modules, which transitively reach
 * `getDbInstance()`. Opening a real better-sqlite3 handle there leaves native
 * `Statement` objects alive when the worker tears down; their destructor calls
 * `RemoveEnvironmentCleanupHook()` on an already-destroyed `node::Environment`,
 * which aborts the process:
 *
 *   Assertion failed: (env) != nullptr  →  SIGABRT  →  build worker dies
 *
 * The build never needs persisted data (the in-memory DB it used before was
 * always empty anyway), so the stub returns empty results for every read and
 * silently drops every write. No native handle is created, so nothing can
 * crash at teardown.
 */
import type { PreparedStatement, RunResult, SqliteAdapter } from "./types";

const EMPTY_RUN_RESULT: RunResult = { changes: 0, lastInsertRowid: 0 };

const NOOP_STATEMENT: PreparedStatement = {
  run: () => EMPTY_RUN_RESULT,
  get: () => undefined,
  all: () => [],
};

export function createBuildStubAdapter(): SqliteAdapter {
  let open = true;

  return {
    driver: "stub",
    get open() {
      return open;
    },
    name: ":build-stub:",

    prepare: () => NOOP_STATEMENT,
    exec: () => {},
    pragma: () => [],

    transaction<T>(fn: (...args: unknown[]) => T) {
      return (...args: unknown[]) => fn(...args);
    },
    immediate(fn: () => void) {
      fn();
    },

    backup: async () => {},
    checkpoint: () => {},
    close() {
      open = false;
    },

    raw: null,
  };
}
