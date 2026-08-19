import test from "node:test";
import assert from "node:assert/strict";

import { resolveDbDriverConfig, DbDriverConfigError } from "../../src/lib/db/driverConfig";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("defaults to sqlite when DB_DRIVER is unset", () => {
  withEnv({ DB_DRIVER: undefined, DATABASE_URL: undefined }, () => {
    const config = resolveDbDriverConfig();
    assert.equal(config.driver, "sqlite");
    assert.equal(config.databaseUrl, null);
  });
});

test("defaults to sqlite when DB_DRIVER is blank", () => {
  withEnv({ DB_DRIVER: "  ", DATABASE_URL: undefined }, () => {
    const config = resolveDbDriverConfig();
    assert.equal(config.driver, "sqlite");
  });
});

test("resolves postgres when DATABASE_URL is set", () => {
  withEnv(
    { DB_DRIVER: "postgres", DATABASE_URL: "postgres://user:pass@localhost:5432/omniroute" },
    () => {
      const config = resolveDbDriverConfig();
      assert.equal(config.driver, "postgres");
      assert.equal(config.databaseUrl, "postgres://user:pass@localhost:5432/omniroute");
    }
  );
});

test("fails fast when DB_DRIVER=postgres and DATABASE_URL is missing", () => {
  withEnv({ DB_DRIVER: "postgres", DATABASE_URL: undefined }, () => {
    assert.throws(() => resolveDbDriverConfig(), DbDriverConfigError);
  });
});

test("fails fast when DB_DRIVER=postgres and DATABASE_URL is blank", () => {
  withEnv({ DB_DRIVER: "postgres", DATABASE_URL: "  " }, () => {
    assert.throws(() => resolveDbDriverConfig(), DbDriverConfigError);
  });
});

test("rejects an unknown DB_DRIVER value", () => {
  withEnv({ DB_DRIVER: "mysql", DATABASE_URL: undefined }, () => {
    assert.throws(() => resolveDbDriverConfig(), DbDriverConfigError);
  });
});
