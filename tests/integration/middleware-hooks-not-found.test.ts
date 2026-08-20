import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression guard: PUT/DELETE /api/middleware/hooks/[name] must 404 for a
 * hook that does not exist. Both handlers gate on `await getMiddlewareHook(name)`
 * before mutating — a missing `await` there makes the resulting Promise object
 * always truthy, silently skipping the 404 branch (caught during the
 * middleware.ts dual-dialect conversion).
 */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-middleware-hooks-404-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
core.resetDbInstance();

const nameRoute = await import("../../src/app/api/middleware/hooks/[name]/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const MISSING = "does-not-exist-hook";

test("PUT /api/middleware/hooks/[name] returns 404 for a nonexistent hook", async () => {
  const req = new Request(`http://localhost/api/middleware/hooks/${MISSING}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "x" }),
  });
  const res = await nameRoute.PUT(req, { params: Promise.resolve({ name: MISSING }) });
  assert.equal(res.status, 404);
});

test("DELETE /api/middleware/hooks/[name] returns 404 for a nonexistent hook", async () => {
  const req = new Request(`http://localhost/api/middleware/hooks/${MISSING}`, {
    method: "DELETE",
  });
  const res = await nameRoute.DELETE(req, { params: Promise.resolve({ name: MISSING }) });
  assert.equal(res.status, 404);
});
