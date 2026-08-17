import type { SqliteAdapter, PreparedStatement, RunResult } from "./types";

/**
 * Upper bound on retained prepared statements. Callers use a small, mostly
 * static set of SQL strings; the cap only guards against a pathological caller
 * that builds unbounded dynamic SQL. Once reached, extra statements are still
 * returned — just not retained.
 */
const MAX_CACHED_STATEMENTS = 1000;

export function createBetterSqliteAdapter(db: import("better-sqlite3").Database): SqliteAdapter {
  /**
   * Retains every prepared statement for the lifetime of the connection.
   *
   * Beyond the obvious win of not re-compiling the same SQL, this keeps native
   * better-sqlite3 `Statement` objects out of the garbage collector. When one is
   * finalized by a GC pass that runs with no Node environment entered, its
   * destructor calls `RemoveEnvironmentCleanupHook()` with a null environment:
   *
   *   Assertion failed: (env) != nullptr  ->  SIGABRT
   *
   * That aborted the container on 2 of 3 boots on Coolify, always moments after
   * the instrumentation hook finished its SQLite-heavy startup work — the point
   * where a burst of throwaway statements becomes collectable. A statement that
   * is never collected can never be finalized at a bad time.
   */
  const statementCache = new Map<string, PreparedStatement>();

  return {
    driver: "better-sqlite3",

    get open() {
      return db.open;
    },

    get name() {
      return db.name;
    },

    prepare(sql: string): PreparedStatement {
      const cached = statementCache.get(sql);
      if (cached) return cached;

      const stmt = db.prepare(sql);
      const wrapper: PreparedStatement = {
        run: (...params: unknown[]): RunResult => stmt.run(...params) as unknown as RunResult,
        get: (...params: unknown[]): unknown => stmt.get(...params),
        all: (...params: unknown[]): unknown[] => stmt.all(...params),
      };

      if (statementCache.size < MAX_CACHED_STATEMENTS) {
        statementCache.set(sql, wrapper);
      }
      return wrapper;
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    pragma(pragmaStr: string, options?: { simple?: boolean }): unknown {
      return db.pragma(pragmaStr, options);
    },

    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return db.transaction(fn) as (...args: unknown[]) => T;
    },

    immediate(fn: () => void): void {
      (db.transaction(fn) as unknown as { immediate: () => void }).immediate();
    },

    async backup(destination: string): Promise<void> {
      await db.backup(destination);
    },

    checkpoint(mode = "TRUNCATE"): void {
      try {
        db.pragma(`wal_checkpoint(${mode})`);
      } catch {}
    },

    close(): void {
      // Drop the retained statements first: `db.close()` finalizes them while a
      // JS context is still entered, so their later destructors are inert.
      statementCache.clear();
      db.close();
    },

    get raw() {
      return db;
    },
  };
}
