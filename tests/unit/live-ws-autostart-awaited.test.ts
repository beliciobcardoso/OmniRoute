/**
 * Regression guard: the live dashboard WebSocket daemon must expose its auto-start
 * promise, and `instrumentation-node.ts` must await it.
 *
 * Bug: the module fired `startLiveDashboardServer()` and dropped the promise, while
 * the instrumentation hook only awaited the `import()`. Startup therefore continued
 * after Next.js finished `register()` and tore that context down. The startup path
 * touches SQLite, so native better-sqlite3 `Statement` objects were finalized after
 * the `node::Environment` was destroyed:
 *
 *   Assertion failed: (env) != nullptr → SIGABRT
 *
 * That aborted 3 of 4 container boots on Coolify (`exited:unhealthy` crash-loop).
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

test("liveServer exports the auto-start promise instead of dropping it", async () => {
  // Disabled + not build/test so importing the module cannot bind a real port here.
  process.env.OMNIROUTE_ENABLE_LIVE_WS = "0";

  const mod = await import("../../src/server/ws/liveServer.ts");

  assert.equal(
    typeof mod.getLiveWsAutoStartPromise,
    "function",
    "liveServer must expose getLiveWsAutoStartPromise() so callers can await the startup"
  );
  assert.equal(
    mod.getLiveWsAutoStartPromise(),
    undefined,
    "no auto-start promise when OMNIROUTE_ENABLE_LIVE_WS=0"
  );
});

test("liveServer auto-start assigns the promise rather than fire-and-forget", () => {
  const src = readFileSync(join(REPO_ROOT, "src/server/ws/liveServer.ts"), "utf8");

  assert.match(
    src,
    /autoStartPromise\s*=\s*startLiveDashboardServer\(/,
    "the auto-start must be captured in autoStartPromise — a bare " +
      "startLiveDashboardServer(...).catch(...) lets SQLite work outlive the caller's context"
  );
});

test("instrumentation awaits the live WS auto-start before finishing register()", () => {
  const src = readFileSync(join(REPO_ROOT, "src/instrumentation-node.ts"), "utf8");

  assert.match(
    src,
    /getLiveWsAutoStartPromise\(\)/,
    "instrumentation must await getLiveWsAutoStartPromise(); awaiting only the import() " +
      "lets the daemon's native SQLite handles be finalized after this context is destroyed"
  );

  const bootstrapIdx = src.indexOf('await import("@/server/ws/liveServer")');
  const awaitIdx = src.indexOf("getLiveWsAutoStartPromise()");
  assert.ok(bootstrapIdx > -1, "liveServer import must still be present");
  assert.ok(
    awaitIdx > bootstrapIdx,
    "the auto-start await must follow the module import, inside the same try block"
  );
});
