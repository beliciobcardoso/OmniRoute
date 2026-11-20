import test from "node:test";
import assert from "node:assert/strict";

import {
  getPostgresDb,
  resetPostgresDb,
  PostgresNotConfiguredError,
} from "../../../../src/lib/db/postgres/client.ts";
import { __testing } from "../../../../src/lib/db/postgres/dialect.ts";

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("getPostgresDb throws when the sqlite backend is selected", async () => {
  await resetPostgresDb();
  await withEnv({ DB_DRIVER: undefined, DATABASE_URL: undefined }, () => {
    assert.throws(() => getPostgresDb(), PostgresNotConfiguredError);
  });
});

test("getPostgresDb returns one cached Kysely instance when DB_DRIVER=postgres", async () => {
  await resetPostgresDb();
  await withEnv(
    {
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:pass@localhost:5432/omniroute",
      OMNIROUTE_POSTGRES_PARTIAL_BACKEND: "1",
    },
    () => {
      const db = getPostgresDb();
      assert.equal(typeof db.selectFrom, "function");
      assert.equal(getPostgresDb(), db);
    }
  );
  await resetPostgresDb();
});

test("BIGINT columns are parsed to numbers, matching the SQLite repositories", () => {
  const parse = __testing.poolTypes.getTypeParser(20, "text") as (value: string) => unknown;
  assert.equal(parse("1732100000000"), 1732100000000);
  assert.equal(parse("-5"), -5);
});

test("BIGINT values beyond Number.MAX_SAFE_INTEGER fail loudly instead of losing precision", () => {
  assert.throws(() => __testing.parseInt8("9007199254740993"), RangeError);
});

test("non-INT8 types keep the default node-postgres parser", () => {
  const parse = __testing.poolTypes.getTypeParser(16, "text") as (value: string) => unknown;
  assert.equal(parse("t"), true);
});
