/**
 * Regression guard: the better-sqlite3 adapter must retain prepared statements.
 *
 * A throwaway `db.prepare(sql).get()` leaves a native `Statement` for the GC.
 * When one is finalized by a pass that runs with no Node environment entered,
 * its destructor calls `RemoveEnvironmentCleanupHook()` on a null environment:
 *
 *   Assertion failed: (env) != nullptr → SIGABRT
 *
 * On Coolify that aborted 2 of 3 container boots, always right after the
 * SQLite-heavy instrumentation startup — the moment a burst of throwaway
 * statements becomes collectable. Retained statements are never finalized.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import Database from "better-sqlite3";

import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.ts";

function makeAdapter() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  return { db, adapter: createBetterSqliteAdapter(db) };
}

test("prepare() returns the same retained statement for identical SQL", () => {
  const { db, adapter } = makeAdapter();
  try {
    const sql = "SELECT v FROM t WHERE id = ?";
    assert.equal(
      adapter.prepare(sql),
      adapter.prepare(sql),
      "identical SQL must reuse the retained statement — a fresh native Statement " +
        "per call is exactly the GC-finalization hazard this cache removes"
    );
  } finally {
    db.close();
  }
});

test("retained statements stay usable across calls", () => {
  const { db, adapter } = makeAdapter();
  try {
    adapter.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "a");
    adapter.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(2, "b");

    const read = adapter.prepare("SELECT v FROM t WHERE id = ?");
    assert.deepEqual(read.get(1), { v: "a" });
    assert.deepEqual(read.get(2), { v: "b" });
    assert.equal(adapter.prepare("SELECT COUNT(*) AS c FROM t").all().length, 1);
  } finally {
    db.close();
  }
});

test("distinct SQL gets distinct statements", () => {
  const { db, adapter } = makeAdapter();
  try {
    assert.notEqual(
      adapter.prepare("SELECT id FROM t"),
      adapter.prepare("SELECT v FROM t"),
      "different SQL must not collide in the cache"
    );
  } finally {
    db.close();
  }
});

test("close() drops the cache so statements are finalized in a live context", () => {
  const { adapter } = makeAdapter();
  adapter.prepare("SELECT id FROM t");

  adapter.close();

  assert.equal(adapter.open, false, "adapter must report the connection closed");
  assert.throws(
    () => adapter.prepare("SELECT id FROM t"),
    "a cleared cache must hit the closed handle and throw, never hand back a " +
      "statement bound to a connection that no longer exists"
  );
});
