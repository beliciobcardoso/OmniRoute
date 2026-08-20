import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-oneproxy-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const mod = await import("../../src/lib/db/oneproxy.ts");

async function resetStorage() {
  core.resetDbInstance();

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      }
      break;
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }

  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("upsertOneproxyProxy creates then updates the same host:port", async () => {
  const created = await mod.upsertOneproxyProxy({
    ip: "203.0.113.1",
    port: 8080,
    protocol: "http",
    countryCode: "US",
    qualityScore: 80,
  });
  assert.equal(created.action, "created");
  assert.equal(created.proxy?.host, "203.0.113.1");
  assert.equal(created.proxy?.qualityScore, 80);

  const updated = await mod.upsertOneproxyProxy({
    ip: "203.0.113.1",
    port: 8080,
    protocol: "http",
    countryCode: "US",
    qualityScore: 95,
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.proxy?.id, created.proxy?.id);
  assert.equal(updated.proxy?.qualityScore, 95);
});

test("listOneproxyProxies filters by protocol, countryCode, and minQuality", async () => {
  await mod.upsertOneproxyProxy({
    ip: "1.1.1.1",
    port: 80,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
  });
  await mod.upsertOneproxyProxy({
    ip: "2.2.2.2",
    port: 443,
    protocol: "socks5",
    countryCode: "BR",
    qualityScore: 40,
  });

  const httpOnly = await mod.listOneproxyProxies({ protocol: "http" });
  assert.equal(httpOnly.length, 1);
  assert.equal(httpOnly[0].host, "1.1.1.1");

  const brOnly = await mod.listOneproxyProxies({ countryCode: "BR" });
  assert.equal(brOnly.length, 1);
  assert.equal(brOnly[0].host, "2.2.2.2");

  const highQuality = await mod.listOneproxyProxies({ minQuality: 50 });
  assert.equal(highQuality.length, 1);
  assert.equal(highQuality[0].host, "1.1.1.1");
});

test("getOneproxyStats aggregates totals, protocol, and country breakdowns", async () => {
  await mod.upsertOneproxyProxy({
    ip: "1.1.1.1",
    port: 80,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
  });
  await mod.upsertOneproxyProxy({
    ip: "2.2.2.2",
    port: 443,
    protocol: "socks5",
    countryCode: "BR",
    qualityScore: 40,
  });

  const stats = await mod.getOneproxyStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.active, 2);
  assert.ok(stats.byProtocol.some((p) => p.protocol === "http" && p.count === 1));
  assert.ok(stats.byCountry.some((c) => c.countryCode === "US" && c.count === 1));
});

test("getOneproxyProxyForRotation respects the quality strategy", async () => {
  await mod.upsertOneproxyProxy({ ip: "1.1.1.1", port: 80, protocol: "http", qualityScore: 40 });
  await mod.upsertOneproxyProxy({ ip: "2.2.2.2", port: 443, protocol: "http", qualityScore: 90 });

  const best = await mod.getOneproxyProxyForRotation({ strategy: "quality" });
  assert.equal(best?.host, "2.2.2.2");
});

test("markOneproxyProxyFailed decrements quality and deactivates once already at/below threshold", async () => {
  const { proxy } = await mod.upsertOneproxyProxy({
    ip: "1.1.1.1",
    port: 80,
    protocol: "http",
    qualityScore: 15,
  });

  // The deactivation check is against the pre-decrement score (15 > 10),
  // so this first failure only lowers quality without deactivating yet.
  const first = await mod.markOneproxyProxyFailed("1.1.1.1", 80);
  assert.equal(first, true);
  const afterFirst = await mod.getOneproxyProxyById(proxy!.id);
  assert.equal(afterFirst?.qualityScore, 5);
  assert.equal(afterFirst?.status, "active");

  // Second failure: pre-decrement score is now 5 (<=10) → deactivates.
  const second = await mod.markOneproxyProxyFailed("1.1.1.1", 80);
  assert.equal(second, true);
  const afterSecond = await mod.getOneproxyProxyById(proxy!.id);
  assert.equal(afterSecond?.qualityScore, 0);
  assert.equal(afterSecond?.status, "inactive");

  const missing = await mod.markOneproxyProxyFailed("9.9.9.9", 9999);
  assert.equal(missing, false);
});

test("deleteOneproxyProxy and clearAllOneproxyProxies remove records", async () => {
  const { proxy: p1 } = await mod.upsertOneproxyProxy({
    ip: "1.1.1.1",
    port: 80,
    protocol: "http",
  });
  await mod.upsertOneproxyProxy({ ip: "2.2.2.2", port: 443, protocol: "http" });

  assert.equal(await mod.deleteOneproxyProxy(p1!.id), true);
  assert.equal(await mod.deleteOneproxyProxy(p1!.id), false);
  assert.equal((await mod.listOneproxyProxies()).length, 1);

  const deletedCount = await mod.clearAllOneproxyProxies();
  assert.equal(deletedCount, 1);
  assert.equal((await mod.listOneproxyProxies()).length, 0);
});
