import test from "node:test";
import assert from "node:assert/strict";

import { selectRoutingConfigRepositories } from "../../../../src/lib/db/repositories/routingConfigRepositories.ts";
import { postgresComboRepository } from "../../../../src/lib/db/repositories/postgresComboRepository.ts";
import { postgresModelComboMappingRepository } from "../../../../src/lib/db/repositories/postgresModelComboMappingRepository.ts";
import { sqliteComboRepository } from "../../../../src/lib/db/repositories/sqliteComboRepository.ts";
import { sqliteModelComboMappingRepository } from "../../../../src/lib/db/repositories/sqliteModelComboMappingRepository.ts";

test("the sqlite backend binds the SQLite repositories", () => {
  const repos = selectRoutingConfigRepositories("sqlite");
  assert.equal(repos.combos, sqliteComboRepository);
  assert.equal(repos.modelComboMappings, sqliteModelComboMappingRepository);
});

test("the postgres backend binds the Postgres repositories", () => {
  const repos = selectRoutingConfigRepositories("postgres");
  assert.equal(repos.combos, postgresComboRepository);
  assert.equal(repos.modelComboMappings, postgresModelComboMappingRepository);
});

test("the default binding follows DB_DRIVER and stays SQLite when unset", () => {
  const previous = process.env.DB_DRIVER;
  delete process.env.DB_DRIVER;
  try {
    assert.equal(selectRoutingConfigRepositories().combos, sqliteComboRepository);
  } finally {
    if (previous !== undefined) process.env.DB_DRIVER = previous;
  }
});
