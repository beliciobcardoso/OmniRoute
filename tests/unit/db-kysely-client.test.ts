import test from "node:test";
import assert from "node:assert/strict";

import {
  getKyselyDb,
  resetKyselyDb,
  KyselyNotAvailableError,
} from "../../src/lib/db/kysely/client";

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

test("getKyselyDb throws when DB_DRIVER=sqlite (not wired up yet)", async () => {
  await resetKyselyDb();
  await withEnv({ DB_DRIVER: undefined, DATABASE_URL: undefined }, () => {
    assert.throws(() => getKyselyDb(), KyselyNotAvailableError);
  });
});

test("getKyselyDb returns a Kysely instance when DB_DRIVER=postgres", async () => {
  await resetKyselyDb();
  await withEnv(
    { DB_DRIVER: "postgres", DATABASE_URL: "postgres://user:pass@localhost:5432/omniroute" },
    async () => {
      const db = getKyselyDb();
      assert.equal(typeof db.selectFrom, "function");
      // Same call returns the cached instance rather than building a new pool.
      assert.equal(getKyselyDb(), db);
    }
  );
  await resetKyselyDb();
});
