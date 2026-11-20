import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";

import { registerComboRepositoryConformance } from "../../helpers/persistence/comboRepositoryConformance.ts";

/**
 * Runs the upstream combo repository conformance suite against the Postgres
 * implementation (the same suite tests/unit/db/repositories/ runs against
 * SQLite). Needs a real Postgres at DATABASE_URL — see bootstrap.test.ts.
 * Combo-owned state in still-SQLite domains is cleaned through a throwaway
 * SQLite DATA_DIR.
 */
const SKIP = !process.env.DATABASE_URL;

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pg-combo-repo-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DB_DRIVER = "postgres";
process.env.OMNIROUTE_POSTGRES_PARTIAL_BACKEND = "1";

const core = await import("../../../src/lib/db/core.ts");
const { getPostgresDb, ensurePostgresBootstrap, resetPostgresDb } =
  await import("../../../src/lib/db/postgres/client.ts");
const { postgresComboRepository, importPostgresComboBatch } =
  await import("../../../src/lib/db/repositories/postgresComboRepository.ts");
const { postgresModelComboMappingRepository } =
  await import("../../../src/lib/db/repositories/postgresModelComboMappingRepository.ts");

async function resetStorage(): Promise<void> {
  await ensurePostgresBootstrap();
  await sql`TRUNCATE combos, model_combo_mappings CASCADE`.execute(getPostgresDb());
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

if (!SKIP) {
  registerComboRepositoryConformance(async () => ({
    combos: postgresComboRepository,
    mappings: postgresModelComboMappingRepository,
    reset: resetStorage,
    async corruptComboPayload(comboId: string): Promise<void> {
      await getPostgresDb()
        .updateTable("combos")
        .set({ data: "" })
        .where("id", "=", comboId)
        .execute();
    },
  }));
}

function seedApiKeyGrant(id: string, allowedCombos: string[]): void {
  const db = core.getDbInstance();
  // Fill only required columns that have no default; everything else keeps its default.
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(api_keys)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>
    )
      .filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0)
      .map((c) => c.name)
  );
  const values: Record<string, unknown> = { id, allowed_combos: JSON.stringify(allowedCombos) };
  for (const col of columns) if (!(col in values)) values[col] = `${col}-${id}`;
  const keys = Object.keys(values);
  db.prepare(
    `INSERT INTO api_keys (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`
  ).run(...keys.map((k) => values[k]));
}

function grantsOf(id: string): unknown {
  const row = core
    .getDbInstance()
    .prepare("SELECT allowed_combos FROM api_keys WHERE id = ?")
    .get(id) as { allowed_combos: string } | undefined;
  return row ? JSON.parse(row.allowed_combos) : undefined;
}

test(
  "deleting a Postgres combo revokes its key grants in the SQLite apiKeys domain",
  { skip: SKIP },
  async () => {
    await resetStorage();
    const combo = await postgresComboRepository.create({ name: "Grant Target", models: [] });
    seedApiKeyGrant("k1", ["Grant Target", "other"]);

    assert.equal(await postgresComboRepository.deleteById(String(combo.id)), true);
    assert.deepEqual(grantsOf("k1"), ["other"]);
  }
);

test(
  "grants survive while another Postgres combo still uses the name (any case)",
  { skip: SKIP },
  async () => {
    await resetStorage();
    const first = await postgresComboRepository.create({ name: "Shared", models: [] });
    await postgresComboRepository.create({ name: "shared", models: [] });
    seedApiKeyGrant("k2", ["Shared"]);

    assert.equal(await postgresComboRepository.deleteById(String(first.id)), true);
    assert.deepEqual(grantsOf("k2"), ["Shared"]);
  }
);

test(
  "replace-import keeps hidden combos and only revokes names it did not bring back",
  { skip: SKIP },
  async () => {
    await resetStorage();
    await postgresComboRepository.create({ name: "Kept Name", models: [] });
    await postgresComboRepository.create({ name: "Dropped", models: [] });
    await postgresComboRepository.create({ name: "System", models: [], isHidden: true });
    seedApiKeyGrant("k3", ["Kept Name", "Dropped"]);

    const result = await importPostgresComboBatch([{ name: "Kept Name", models: [] }], {
      replaceVisible: true,
    });

    assert.equal(result.removed, 2);
    assert.equal(result.created.length, 1);
    const names = (await postgresComboRepository.list()).map((c) => c.name).sort();
    assert.deepEqual(names, ["Kept Name", "System"]);
    assert.deepEqual(grantsOf("k3"), ["Kept Name"]);
  }
);

test("a failing import rolls back every insert and deletion", { skip: SKIP }, async () => {
  await resetStorage();
  await postgresComboRepository.create({ name: "Original", models: [] });

  await assert.rejects(
    importPostgresComboBatch(
      [
        { name: "New One", models: [] },
        { name: "New One", models: [] },
      ],
      { replaceVisible: true }
    )
  );
  const names = (await postgresComboRepository.list()).map((c) => c.name);
  assert.deepEqual(names, ["Original"]);
});

test("concurrent creates get distinct, gapless sort orders", { skip: SKIP }, async () => {
  await resetStorage();
  const created = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      postgresComboRepository.create({ name: `C${i}`, models: [] })
    )
  );
  const orders = created.map((c) => c.sortOrder as number).sort((a, b) => a - b);
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test.after(async () => {
  await resetPostgresDb();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
