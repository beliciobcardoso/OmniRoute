import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-prompts-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const promptsDb = await import("../../src/lib/db/prompts.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("savePrompt creates version 1, is idempotent for identical content, and creates version 2 on change", async () => {
  const v1 = await promptsDb.savePrompt("greeting", "Hello {{name}}", {
    variables: ["name"],
    description: "greeting prompt",
  });
  assert.equal(v1.version, 1);
  assert.equal(v1.isActive, true);
  assert.equal(v1.slug, "greeting");

  const v1Again = await promptsDb.savePrompt("greeting", "Hello {{name}}", {
    variables: ["name"],
  });
  assert.equal(v1Again.version, 1, "identical content should not create a new version");
  assert.equal(v1Again.id, v1.id);

  const v2 = await promptsDb.savePrompt("greeting", "Hi {{name}}!", { variables: ["name"] });
  assert.equal(v2.version, 2);
  assert.equal(v2.isActive, true);

  const active = await promptsDb.getActivePrompt("greeting");
  assert.equal(active?.version, 2);
  assert.equal(active?.content, "Hi {{name}}!");
});

test("getPromptVersion and listPromptVersions return the correct rows", async () => {
  await promptsDb.savePrompt("welcome", "v1 content");
  await promptsDb.savePrompt("welcome", "v2 content");
  await promptsDb.savePrompt("welcome", "v3 content");

  const v2 = await promptsDb.getPromptVersion("welcome", 2);
  assert.equal(v2?.content, "v2 content");
  assert.equal(v2?.isActive, false);

  const versions = await promptsDb.listPromptVersions("welcome");
  assert.equal(versions.length, 3);
  assert.deepEqual(
    versions.map((v) => v.version),
    [3, 2, 1]
  );
});

test("listPrompts aggregates active version and total versions per slug", async () => {
  await promptsDb.savePrompt("a", "a1");
  await promptsDb.savePrompt("a", "a2");
  await promptsDb.savePrompt("b", "b1");

  const list = await promptsDb.listPrompts();
  const a = list.find((p) => p.slug === "a");
  const b = list.find((p) => p.slug === "b");

  assert.equal(a?.activeVersion, 2);
  assert.equal(a?.totalVersions, 2);
  assert.equal(b?.activeVersion, 1);
  assert.equal(b?.totalVersions, 1);
});

test("rollbackPrompt reactivates an older version", async () => {
  await promptsDb.savePrompt("rollme", "first");
  await promptsDb.savePrompt("rollme", "second");
  await promptsDb.savePrompt("rollme", "third");

  const rolled = await promptsDb.rollbackPrompt("rollme", 1);
  assert.equal(rolled?.version, 1);
  assert.equal(rolled?.isActive, true);
  assert.equal(rolled?.content, "first");

  const active = await promptsDb.getActivePrompt("rollme");
  assert.equal(active?.version, 1);

  const versions = await promptsDb.listPromptVersions("rollme");
  const others = versions.filter((v) => v.version !== 1);
  assert.ok(others.every((v) => v.isActive === false));
});

test("rollbackPrompt returns null for a non-existent version", async () => {
  await promptsDb.savePrompt("solo", "only version");
  const result = await promptsDb.rollbackPrompt("solo", 99);
  assert.equal(result, null);
});

test("renderPrompt substitutes variables from the active version", async () => {
  await promptsDb.savePrompt("render-me", "Hello {{name}}, welcome to {{place}}!", {
    variables: ["name", "place"],
  });

  const rendered = await promptsDb.renderPrompt("render-me", {
    name: "Ana",
    place: "OmniRoute",
  });
  assert.equal(rendered, "Hello Ana, welcome to OmniRoute!");

  const missingSlug = await promptsDb.renderPrompt("does-not-exist", {});
  assert.equal(missingSlug, null);
});
