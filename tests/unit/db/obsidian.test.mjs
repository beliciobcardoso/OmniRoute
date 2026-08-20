import { test } from "node:test";
import assert from "node:assert";

test("obsidian DB module exports expected functions", async () => {
  const mod = await import("../../../src/lib/db/obsidian.ts");
  assert.equal(typeof mod.getObsidianToken, "function");
  assert.equal(typeof mod.setObsidianToken, "function");
  assert.equal(typeof mod.clearObsidianToken, "function");
  assert.equal(typeof mod.getObsidianConfig, "function");
});

test("getObsidianConfig returns expected shape", async () => {
  const { getObsidianConfig } = await import("../../../src/lib/db/obsidian.ts");
  const config = await getObsidianConfig();
  assert.ok(typeof config === "object");
  assert.ok("connected" in config);
  assert.ok("token" in config);
  assert.equal(typeof config.connected, "boolean");
});

test("setObsidianToken and clearObsidianToken are callable without DB", async () => {
  const { setObsidianToken, clearObsidianToken } = await import("../../../src/lib/db/obsidian.ts");
  await assert.doesNotReject(() => setObsidianToken("test"));
  await assert.doesNotReject(() => clearObsidianToken());
});

test("setObsidianToken persists a token that getObsidianToken/getObsidianConfig read back, then clearObsidianToken removes it", async () => {
  const { getObsidianToken, setObsidianToken, clearObsidianToken, getObsidianConfig } =
    await import("../../../src/lib/db/obsidian.ts");

  await clearObsidianToken();
  assert.equal(await getObsidianToken(), null);

  await setObsidianToken("roundtrip-obsidian-token");
  assert.equal(await getObsidianToken(), "roundtrip-obsidian-token");
  const config = await getObsidianConfig();
  assert.equal(config.connected, true);
  assert.equal(config.token, "roundtrip-obsidian-token");

  await clearObsidianToken();
  assert.equal(await getObsidianToken(), null);
});
