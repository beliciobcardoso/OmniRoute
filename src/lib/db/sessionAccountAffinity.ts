import { createHash } from "crypto";

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

type SessionAccountAffinityRecord = {
  connectionId: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

const NAMESPACE = "session_account_affinity";
const CLEANUP_INTERVAL_MS = 5 * 60_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function normalizePositiveTtl(ttlMs: number | null | undefined): number {
  return Number.isFinite(ttlMs) && Number(ttlMs) > 0 ? Number(ttlMs) : 0;
}

function affinityKey(sessionKey: string, provider: string): string {
  const hash = createHash("sha256").update(`${provider}:${sessionKey}`).digest("hex");
  return `${provider}:${hash}`;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function parseRecord(value: unknown): SessionAccountAffinityRecord | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<SessionAccountAffinityRecord>;
    if (typeof parsed.connectionId !== "string" || parsed.connectionId.trim().length === 0) {
      return null;
    }
    if (typeof parsed.expiresAt !== "string" || Number.isNaN(Date.parse(parsed.expiresAt))) {
      return null;
    }
    return {
      connectionId: parsed.connectionId,
      createdAt:
        typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt))
          ? parsed.createdAt
          : parsed.expiresAt,
      lastUsedAt:
        typeof parsed.lastUsedAt === "string" && !Number.isNaN(Date.parse(parsed.lastUsedAt))
          ? parsed.lastUsedAt
          : parsed.expiresAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function deleteAffinityKey(key: string): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .deleteFrom("key_value")
      .where("namespace", "=", NAMESPACE)
      .where("key", "=", key)
      .execute();
    return;
  }

  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, key);
}

export async function getSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  ttlMs = 0,
  now: number = Date.now()
): Promise<SessionAccountAffinityRecord | null> {
  if (!sessionKey || !provider || normalizePositiveTtl(ttlMs) <= 0) return null;

  const key = affinityKey(sessionKey, provider);
  let rawValue: unknown;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("key_value")
      .select("value")
      .where("namespace", "=", NAMESPACE)
      .where("key", "=", key)
      .executeTakeFirst();
    rawValue = row?.value;
  } else {
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(NAMESPACE, key) as { value?: unknown } | undefined;
    rawValue = row?.value;
  }

  const record = parseRecord(rawValue);
  if (!record) return null;

  if (Date.parse(record.expiresAt) <= now) {
    await deleteAffinityKey(key);
    return null;
  }

  return record;
}

export async function upsertSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  connectionId: string,
  now: number = Date.now(),
  ttlMs = 0
): Promise<void> {
  const normalizedTtlMs = normalizePositiveTtl(ttlMs);
  if (!sessionKey || !provider || !connectionId || normalizedTtlMs <= 0) return;

  const key = affinityKey(sessionKey, provider);
  const existing = await getSessionAccountAffinity(sessionKey, provider, normalizedTtlMs, now);
  const timestamp = isoFromMs(now);
  const record: SessionAccountAffinityRecord = {
    connectionId,
    createdAt: existing?.createdAt ?? timestamp,
    lastUsedAt: timestamp,
    expiresAt: isoFromMs(now + normalizedTtlMs),
  };
  const value = JSON.stringify(record);

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: NAMESPACE, key, value })
      .onConflict((oc) => oc.columns(["namespace", "key"]).doUpdateSet({ value }))
      .execute();
    return;
  }

  getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(NAMESPACE, key, value);
}

export async function touchSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  now: number = Date.now(),
  ttlMs = 0
): Promise<void> {
  const normalizedTtlMs = normalizePositiveTtl(ttlMs);
  if (normalizedTtlMs <= 0) return;

  const existing = await getSessionAccountAffinity(sessionKey, provider, normalizedTtlMs, now);
  if (!existing) return;

  await upsertSessionAccountAffinity(
    sessionKey,
    provider,
    existing.connectionId,
    now,
    normalizedTtlMs
  );
}

export async function deleteSessionAccountAffinity(
  sessionKey: string,
  provider: string
): Promise<void> {
  if (!sessionKey || !provider) return;
  await deleteAffinityKey(affinityKey(sessionKey, provider));
}

/**
 * #6219 — Evict a session's pin ONLY when it currently points at `connectionId`.
 *
 * Used by the account-failover paths in chat.ts: when the pinned connection is
 * marked unavailable/exhausted, the sticky pin must be dropped so the next
 * request fails over to another account instead of re-pinning the dead one
 * (previously the session stayed pinned until process restart).
 *
 * Unlike `getSessionAccountAffinity`, this reads the stored record INDEPENDENT
 * of the TTL gate — a 2-arg `getSessionAccountAffinity(key, provider)` read
 * (ttl defaulting to 0) always returns null, which silently defeated the
 * connection-match guard on the earlier failover branches. The connection-match
 * guard is preserved here so a pin pointing at a different (still-healthy)
 * connection is never nuked. Returns true when a pin was evicted.
 */
export async function evictSessionAccountAffinityForConnection(
  sessionKey: string,
  provider: string,
  connectionId: string
): Promise<boolean> {
  if (!sessionKey || !provider || !connectionId) return false;

  const key = affinityKey(sessionKey, provider);
  let rawValue: unknown;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("key_value")
      .select("value")
      .where("namespace", "=", NAMESPACE)
      .where("key", "=", key)
      .executeTakeFirst();
    rawValue = row?.value;
  } else {
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(NAMESPACE, key) as { value?: unknown } | undefined;
    rawValue = row?.value;
  }

  const record = parseRecord(rawValue);
  if (!record || record.connectionId !== connectionId) return false;

  await deleteAffinityKey(key);
  return true;
}

export async function cleanupStaleSessionAccountAffinities(
  _ttlMs: number = 30 * 60 * 1000,
  now: number = Date.now()
): Promise<number> {
  let deleted = 0;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("key_value")
      .select(["key", "value"])
      .where("namespace", "=", NAMESPACE)
      .execute();

    const staleKeys: string[] = [];
    for (const row of rows) {
      const record = parseRecord(row.value);
      if (!record || Date.parse(record.expiresAt) <= now) {
        staleKeys.push(row.key);
      }
    }
    if (staleKeys.length > 0) {
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "=", NAMESPACE)
        .where("key", "in", staleKeys)
        .execute();
      deleted = staleKeys.length;
    }
    return deleted;
  }

  const db = getDbInstance();
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as Array<{ key?: unknown; value?: unknown }>;

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (typeof row.key !== "string") continue;
      const record = parseRecord(row.value);
      if (!record || Date.parse(record.expiresAt) <= now) {
        db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(NAMESPACE, row.key);
        deleted++;
      }
    }
  });

  tx();
  return deleted;
}

export function startSessionAccountAffinityCleanup(): void {
  if (cleanupTimer) return;

  cleanupStaleSessionAccountAffinities().catch((error) => {
    console.warn("[SESSION_AFFINITY] Startup cleanup failed:", error);
  });

  cleanupTimer = setInterval(() => {
    cleanupStaleSessionAccountAffinities().catch((error) => {
      console.warn("[SESSION_AFFINITY] Periodic cleanup failed:", error);
    });
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) cleanupTimer.unref?.();
}

export function stopSessionAccountAffinityCleanupForTests(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
