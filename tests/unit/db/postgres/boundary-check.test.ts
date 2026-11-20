import test from "node:test";
import assert from "node:assert/strict";

import { findViolations, scan } from "../../../../scripts/check/check-postgres-boundary.mjs";

test("business code importing the Postgres backend is a violation", () => {
  const source = 'import { getPostgresDb } from "@/lib/db/postgres/client";\n';
  assert.deepEqual(findViolations("src/app/api/combos/route.ts", source), [
    "src/app/api/combos/route.ts: imports the Postgres backend",
  ]);
});

test("business code importing kysely, pg or driverConfig is a violation", () => {
  assert.equal(
    findViolations("open-sse/services/combo.ts", 'import { sql } from "kysely";').length,
    1
  );
  assert.equal(findViolations("src/lib/foo.ts", 'import pg from "pg";').length, 1);
  assert.equal(
    findViolations(
      "src/lib/db/combos.ts",
      'import { resolveDbDriverConfig } from "./driverConfig";'
    ).length,
    1
  );
});

test("sibling-relative imports from src/lib/db are caught too", () => {
  assert.equal(
    findViolations("src/lib/db/settings.ts", 'import { getPostgresDb } from "./postgres/client";')
      .length,
    1
  );
  assert.equal(
    findViolations("src/lib/db/settings.ts", 'import type { DbDriver } from "./driverConfig.ts";')
      .length,
    1
  );
});

test("dialect branching outside the persistence layer is a violation", () => {
  assert.equal(findViolations("src/lib/db/settings.ts", "if (isPostgres()) {}").length, 1);
});

test("the persistence layer itself may use the backend", () => {
  const source = 'import { sql } from "kysely";\nif (isPostgres()) {}';
  assert.deepEqual(findViolations("src/lib/db/postgres/bootstrap.ts", source), []);
  assert.deepEqual(
    findViolations("src/lib/db/repositories/postgresComboRepository.ts", source),
    []
  );
  assert.deepEqual(findViolations("src/lib/db/driverConfig.ts", source), []);
});

test("mentions inside comments do not count", () => {
  assert.deepEqual(findViolations("src/lib/x.ts", '// import { sql } from "kysely";\n'), []);
});

test("the repository currently respects the boundary", () => {
  assert.deepEqual(scan(), []);
});
