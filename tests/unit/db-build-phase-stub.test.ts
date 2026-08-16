/**
 * Regression guard: during `next build` (NEXT_PHASE=phase-production-build) the
 * DB layer must NOT open a native better-sqlite3 handle.
 *
 * Background: page-data collection workers that opened a real (even in-memory)
 * better-sqlite3 DB crashed at teardown with
 *   `void node::RemoveEnvironmentCleanupHook(...) Assertion failed: (env) != nullptr`
 * → SIGABRT → `Next.js build worker exited with code: null and signal: SIGABRT`,
 * failing the Docker/Coolify arm64 build.
 *
 * The assertion runs in a child process because `isBuildPhase` is resolved from
 * `process.env.NEXT_PHASE` at module-evaluation time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const probe = `
import { getDbInstance, isBuildPhase } from "${path.join(repoRoot, "src/lib/db/core.ts")}";

if (!isBuildPhase) {
  console.log(JSON.stringify({ error: "isBuildPhase is false" }));
  process.exit(1);
}

const db = getDbInstance();
console.log(
  JSON.stringify({
    driver: db.driver,
    all: db.prepare("SELECT * FROM settings").all(),
    get: db.prepare("SELECT * FROM settings").get() ?? null,
    changes: db.prepare("INSERT INTO settings VALUES (1)").run().changes,
    open: db.open,
  })
);
`;

test("build phase never opens a native SQLite handle", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", probe],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NEXT_PHASE: "phase-production-build" },
    }
  );

  // A SIGABRT from the native destructor shows up here as a null exit code.
  assert.equal(
    result.signal,
    null,
    `child process died with signal ${result.signal}: ${result.stderr}`
  );
  assert.equal(result.status, 0, `child process failed: ${result.stderr}`);

  const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) as string);
  assert.equal(payload.driver, "stub", "build phase must use the no-op stub adapter");
  assert.deepEqual(payload.all, []);
  assert.equal(payload.get, null);
  assert.equal(payload.changes, 0);
  assert.equal(payload.open, true);
});
