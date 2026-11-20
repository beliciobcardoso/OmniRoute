import test from "node:test";
import assert from "node:assert/strict";

import {
  mapDefault,
  mapType,
  quoteIdent,
} from "../../../../scripts/db/gen-postgres-schema.ts";

test("maps SQLite affinities to Postgres types", () => {
  assert.equal(mapType("INTEGER", false, "t.c"), "BIGINT");
  assert.equal(mapType("TEXT", false, "t.c"), "TEXT");
  assert.equal(mapType("VARCHAR(32)", false, "t.c"), "TEXT");
  assert.equal(mapType("REAL", false, "t.c"), "DOUBLE PRECISION");
  assert.equal(mapType("BLOB", false, "t.c"), "BYTEA");
  assert.equal(mapType("", false, "t.c"), "TEXT");
  assert.equal(mapType("DATETIME", false, "t.c"), "TEXT");
});

test("boolean overrides only apply to integer columns", () => {
  assert.equal(mapType("INTEGER", true, "t.c"), "BOOLEAN");
  assert.throws(() => mapType("TEXT", true, "t.c"), /listed as boolean/);
});

test("unknown SQLite types fail instead of being guessed", () => {
  assert.throws(() => mapType("GEOMETRY", false, "t.c"), /unsupported SQLite type/);
});

test("translates SQLite defaults to equivalent Postgres expressions", () => {
  assert.equal(mapDefault(null, "TEXT", "t.c"), null);
  assert.equal(mapDefault("NULL", "TEXT", "t.c"), null);
  assert.equal(mapDefault("0", "BIGINT", "t.c"), "0");
  assert.equal(mapDefault("0", "BOOLEAN", "t.c"), "FALSE");
  assert.equal(mapDefault("1", "BOOLEAN", "t.c"), "TRUE");
  assert.equal(mapDefault("'all'", "TEXT", "t.c"), "'all'");
  assert.equal(mapDefault('"upstream"', "TEXT", "t.c"), "'upstream'");
  assert.match(String(mapDefault("CURRENT_TIMESTAMP", "TEXT", "t.c")), /YYYY-MM-DD HH24:MI:SS/);
  assert.match(String(mapDefault("(datetime('now'))", "TEXT", "t.c")), /YYYY-MM-DD HH24:MI:SS/);
  assert.match(String(mapDefault("(strftime('%s','now'))", "BIGINT", "t.c")), /EXTRACT\(EPOCH/);
  assert.match(
    String(mapDefault("(lower(hex(randomblob(8))))", "TEXT", "t.c")),
    /gen_random_uuid\(\)/
  );
});

test("defaults that cannot be translated fail loudly", () => {
  assert.throws(() => mapDefault("(random())", "BIGINT", "t.c"), /untranslatable default/);
  assert.throws(() => mapDefault("2", "BOOLEAN", "t.c"), /boolean column/);
  assert.throws(() => mapDefault("'x'", "BIGINT", "t.c"), /string default/);
});

test("quotes only identifiers Postgres would reject", () => {
  assert.equal(quoteIdent("api_keys"), "api_keys");
  assert.equal(quoteIdent("group"), '"group"');
  assert.equal(quoteIdent("user"), '"user"');
  assert.equal(quoteIdent("Mixed"), '"Mixed"');
});
