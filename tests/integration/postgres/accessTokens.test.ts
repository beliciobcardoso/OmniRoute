import test from "node:test";
import assert from "node:assert/strict";

import {
  createAccessToken,
  verifyAccessToken,
  listAccessTokens,
  getAccessToken,
  revokeAccessToken,
} from "../../../src/lib/db/accessTokens";
import {
  ensurePostgresBootstrap,
  resetKyselyDb,
  getKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "accessTokens (postgres) create/verify/list/revoke lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      const { record, secret } = await createAccessToken({
        name: "pg-laptop",
        scope: "write",
      });
      assert.match(secret, /^oma_live_/);
      assert.equal(record.name, "pg-laptop");

      const verified = await verifyAccessToken(secret);
      assert.equal(verified?.name, "pg-laptop");
      assert.equal(verified?.scope, "write");

      const fetched = await getAccessToken(record.id);
      assert.ok(fetched?.lastUsedAt, "verifyAccessToken must stamp last_used_at");

      const list = await listAccessTokens();
      assert.ok(list.some((t) => t.id === record.id));

      assert.equal(await verifyAccessToken("oma_live_wrong"), null);

      const revoked = await revokeAccessToken(record.id);
      assert.equal(revoked, true);
      assert.equal(await verifyAccessToken(secret), null);
      // idempotent
      assert.equal(await revokeAccessToken(record.id), false);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("cli_access_tokens")
        .where("name", "=", "pg-laptop")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
