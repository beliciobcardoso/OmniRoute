import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-cloudflare-410-model-scope-")
);

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cloudflare-410-model-scope-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const fallback = await import("../../open-sse/services/accountFallback.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const modelLockoutSettings = await import("../../src/lib/resilience/modelLockoutSettings.ts");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PROVIDER = "cloudflare-ai";

// Workers AI answers 410 for a model it removed from the catalog. Observed in
// production on 2026-11-20: one request to the retired @cf/moonshotai/kimi-k2.6
// cooled the whole Cloudflare connection for 24h, so every Free-plan model on
// the same account (gpt-oss-20b, qwen3.8-27b, …) answered 410 until reset.
const DEAD_MODEL = "@cf/moonshotai/kimi-k2.6";
const HEALTHY_MODEL = "@cf/openai/gpt-oss-20b";
const GONE_BODY = JSON.stringify({
  errors: [{ message: "Model @cf/moonshotai/kimi-k2.6 is no longer available", code: 410 }],
  success: false,
});

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedCloudflareConnection(name: string) {
  return providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name,
    apiKey: `cf-${name}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

async function assertLockBoundedByMaxCooldown(
  connectionId: string,
  cooldownMs: number | undefined
) {
  const { maxCooldownMs } = modelLockoutSettings.resolveModelLockoutSettings(
    await readCache.getCachedSettings()
  );
  const lock = fallback.getModelLockoutInfo(PROVIDER, connectionId, DEAD_MODEL);

  assert.ok(lock, "the retired model must hold an active lock");
  assert.ok(lock.remainingMs > 0, "the retired model lock must still be active");
  assert.ok(
    lock.remainingMs <= maxCooldownMs,
    `lock must be bounded by maxCooldownMs (${maxCooldownMs}ms), got ${lock.remainingMs}ms`
  );
  assert.ok(lock.remainingMs < ONE_DAY_MS, "lock must be far below the old 24h cooldown");
  assert.ok(
    typeof cooldownMs === "number" && cooldownMs > 0 && cooldownMs <= maxCooldownMs,
    `reported cooldown must be bounded by maxCooldownMs (${maxCooldownMs}ms), got ${cooldownMs}ms`
  );
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Cloudflare 410 on a retired model locks only that model and keeps the connection usable", async () => {
  const connection = await seedCloudflareConnection("cloudflare-410-model-scope");

  const result = await auth.markAccountUnavailable(
    connection.id,
    410,
    GONE_BODY,
    PROVIDER,
    DEAD_MODEL
  );

  assert.equal(result.shouldFallback, true);

  const after = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(
    after?.rateLimitedUntil ?? null,
    null,
    "410 for one retired Cloudflare model must not apply a connection-wide cooldown"
  );
  assert.equal(after?.testStatus, "active", "the Cloudflare connection must stay active");

  assert.equal(fallback.isModelLocked(PROVIDER, connection.id, DEAD_MODEL), true);
  await assertLockBoundedByMaxCooldown(connection.id, result.cooldownMs);

  assert.equal(
    fallback.isModelLocked(PROVIDER, connection.id, HEALTHY_MODEL),
    false,
    "a healthy Free-plan sibling model must remain unlocked"
  );

  const healthyCredentials = await auth.getProviderCredentials(PROVIDER, null, null, HEALTHY_MODEL);
  assert.equal(
    healthyCredentials?.connectionId,
    connection.id,
    "the same Cloudflare connection must remain selectable for healthy models"
  );
});

test("Cloudflare 410 with an empty body still locks only that model", async () => {
  const connection = await seedCloudflareConnection("cloudflare-410-bare-body");

  const result = await auth.markAccountUnavailable(connection.id, 410, "", PROVIDER, DEAD_MODEL);

  assert.equal(result.shouldFallback, true);
  const after = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(after?.rateLimitedUntil ?? null, null);
  assert.equal(after?.testStatus, "active");
  assert.equal(fallback.isModelLocked(PROVIDER, connection.id, DEAD_MODEL), true);
  await assertLockBoundedByMaxCooldown(connection.id, result.cooldownMs);
});

test("Cloudflare 429 stays connection-scoped: the neuron allocation is per account", async () => {
  const connection = await seedCloudflareConnection("cloudflare-429-control");

  await auth.markAccountUnavailable(
    connection.id,
    429,
    "You have used up your daily free allocation of 10,000 neurons",
    PROVIDER,
    HEALTHY_MODEL
  );

  const after = await providersDb.getProviderConnectionById(connection.id);
  assert.ok(
    after?.rateLimitedUntil,
    "a Cloudflare 429 must still cool the whole connection (the 410 branch must not widen it)"
  );
});
