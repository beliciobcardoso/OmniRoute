import test from "node:test";
import assert from "node:assert/strict";

import {
  updateScore,
  getRank,
  getTopN,
  addXp,
  getXp,
  updateLevel,
  unlockBadge,
  hasBadge,
  getBadges,
  getBadgeDefinitions,
  getAggregateXp,
  getAllEarnedBadges,
  transferTokens,
  getBalance,
  getHistory,
  createInviteToken,
  getInviteByCode,
  redeemInvite,
  revokeInvite,
  getConnectedServerByKeyHash,
  connectServer,
  disconnectServer,
  listServers,
  getLeaderboardNeighbors,
  rotateLeaderboardScope,
} from "../../../src/lib/db/gamification";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "gamification (postgres) leaderboard, XP/badges, token transfers, invites, and federation",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const keyA = `pg-gami-a-${Date.now()}`;
    const keyB = `pg-gami-b-${Date.now()}`;
    const scope = `pg-scope-${Date.now()}`;
    const badgeId = `pg-badge-${Date.now()}`;

    try {
      // ── Leaderboard ──
      await updateScore(keyA, scope, 100);
      await updateScore(keyA, scope, 50); // additive upsert → 150
      await updateScore(keyB, scope, 300);
      assert.equal(await getRank(keyA, scope), 2);
      assert.equal(await getRank(keyB, scope), 1);

      const top = await getTopN(scope, 10);
      assert.equal(top[0].apiKeyId, keyB);
      assert.equal(top[0].score, 300);
      assert.equal(top[1].score, 150);

      const neighbors = await getLeaderboardNeighbors(keyA, scope, 5);
      assert.ok(neighbors.above.some((n) => n.apiKeyId === keyB));
      assert.equal(neighbors.below.length, 0);

      // ── XP & Levels ──
      await addXp(keyA, "test_action", 500);
      const xp = await getXp(keyA);
      assert.equal(xp?.totalXp, 500);
      await addXp(keyA, "test_action", 100); // additive → 600
      assert.equal((await getXp(keyA))?.totalXp, 600);
      await updateLevel(keyA, 42);
      assert.equal((await getXp(keyA))?.currentLevel, 42);

      const agg = await getAggregateXp();
      assert.ok(agg.totalXp >= 600);

      // ── Badges ──
      await getKyselyDb()
        .insertInto("badge_definitions")
        .values({
          id: badgeId,
          name: "PG Test Badge",
          rarity: "common",
          hidden: 0,
        })
        .execute();

      assert.equal(await hasBadge(keyA, badgeId), false);
      await unlockBadge(keyA, badgeId);
      await unlockBadge(keyA, badgeId); // idempotent — no duplicate
      assert.equal(await hasBadge(keyA, badgeId), true);

      const badges = await getBadges(keyA);
      assert.equal(badges.length, 1);
      assert.equal(badges[0].badgeName, "PG Test Badge");

      const defs = await getBadgeDefinitions();
      assert.ok(defs.some((d) => d.id === badgeId));

      await unlockBadge(keyB, badgeId);
      const allEarned = await getAllEarnedBadges();
      assert.ok(allEarned.some((b) => b.badgeId === badgeId));

      // ── Token Ledger (transactional transfer) ──
      // transferTokens() only ever debits an existing balance — there is no
      // app-level minting path (confirmed in tests/unit/gamification/sharing.test.ts,
      // which only ever exercises the insufficient-balance path). Seed keyB
      // with a genesis credit directly so a real transferTokens() success
      // path (and its transaction/idempotency logic) can be exercised here.
      await getKyselyDb()
        .insertInto("token_ledger")
        .values({ from_api_key_id: "genesis", to_api_key_id: keyB, amount: 1000, reason: "seed" })
        .execute();
      assert.equal(await getBalance(keyB), 1000);

      const idempotencyKey = `idem-${Date.now()}`;
      const t1 = await transferTokens(keyB, keyA, 500, "gift", idempotencyKey);
      assert.equal(t1.success, true);
      assert.equal(await getBalance(keyA), 500);
      assert.equal(await getBalance(keyB), 500);

      // Same idempotency key → treated as already-applied, no double-transfer.
      const t1Retry = await transferTokens(keyB, keyA, 500, "gift", idempotencyKey);
      assert.equal(t1Retry.success, true);
      assert.equal(await getBalance(keyA), 500);

      // Insufficient balance.
      const t2 = await transferTokens(keyA, keyB, 999999, "too-much", `idem2-${Date.now()}`);
      assert.equal(t2.success, false);
      assert.equal(t2.error, "insufficient_balance");

      const history = await getHistory(keyA, 10);
      assert.ok(history.length >= 1);

      // ── Invite tokens ──
      const inviteId = `pg-invite-${Date.now()}`;
      const code = `code-${Date.now()}`;
      await createInviteToken(inviteId, code, "hash123", keyA, undefined, 2);
      const invite = await getInviteByCode(code);
      assert.equal(invite?.maxUses, 2);
      assert.equal(invite?.useCount, 0);

      assert.equal(await redeemInvite(code, keyB), true);
      assert.equal((await getInviteByCode(code))?.useCount, 1);
      assert.equal(await redeemInvite(code, "someone-else"), true); // 2nd use — still under max
      assert.equal(await redeemInvite(code, "yet-another"), false); // 3rd use — exceeds max_uses=2

      await revokeInvite(inviteId);
      assert.equal(await redeemInvite(code, "post-revoke"), false);

      // ── Community servers ──
      const serverId = `pg-server-${Date.now()}`;
      await connectServer(serverId, "PG Server", "https://example.test", "hash-abc");
      const found = await getConnectedServerByKeyHash("hash-abc");
      assert.equal(found?.id, serverId);

      const servers = await listServers();
      assert.ok(servers.some((s) => s.id === serverId && s.status === "connected"));

      await disconnectServer(serverId);
      assert.equal(await getConnectedServerByKeyHash("hash-abc"), undefined);

      // Re-connect (ON CONFLICT path) — must fully reset status back to
      // 'connected', matching SQLite's INSERT OR REPLACE semantics.
      await connectServer(serverId, "PG Server Renamed", "https://example2.test", "hash-abc");
      const reconnected = await getConnectedServerByKeyHash("hash-abc");
      assert.equal(reconnected?.id, serverId);

      // ── Leaderboard scope rotation ──
      const rotateScope = `pg-rotate-${Date.now()}`;
      await updateScore(keyA, rotateScope, 42);
      await rotateLeaderboardScope("weekly");
      const stillCurrent = await getTopN(rotateScope, 10);
      // rotateLeaderboardScope only archives the literal "weekly"/"monthly"
      // scope, not arbitrary scopes — our custom scope must be untouched.
      assert.equal(stillCurrent.length, 1);
    } finally {
      await getKyselyDb()
        .deleteFrom("leaderboard")
        .where("scope", "like", "pg-%")
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("user_levels")
        .where("api_key_id", "like", "pg-gami-%")
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("user_badges")
        .where("badge_id", "=", badgeId)
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("badge_definitions")
        .where("id", "=", badgeId)
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("token_ledger")
        .where("from_api_key_id", "like", "pg-gami-%")
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("invite_tokens")
        .where("id", "like", "pg-invite-%")
        .execute()
        .catch(() => {});
      await getKyselyDb()
        .deleteFrom("community_servers")
        .where("id", "like", "pg-server-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
