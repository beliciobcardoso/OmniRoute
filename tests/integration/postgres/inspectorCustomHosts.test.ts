import test from "node:test";
import assert from "node:assert/strict";

import {
  listCustomHosts,
  addCustomHost,
  removeCustomHost,
  toggleCustomHost,
  touchLastSeen,
  isCustomHost,
} from "../../../src/lib/db/inspectorCustomHosts";
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
  "inspectorCustomHosts (postgres) add/list/toggle/touch/remove lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      await addCustomHost("pg-api.openai.com", "llm", "OpenAI");
      await addCustomHost("pg-api.anthropic.com");
      // Idempotent — duplicate insert must be ignored.
      await addCustomHost("pg-api.openai.com");

      const all = await listCustomHosts();
      const pgHosts = all.filter((h) => h.host.startsWith("pg-"));
      assert.equal(pgHosts.length, 2);

      const openaiHost = pgHosts.find((h) => h.host === "pg-api.openai.com");
      assert.equal(openaiHost?.enabled, true);
      assert.equal(openaiHost?.kind, "llm");
      assert.equal(openaiHost?.label, "OpenAI");

      assert.equal(await isCustomHost("pg-api.openai.com"), true);

      await toggleCustomHost("pg-api.openai.com", false);
      assert.equal(await isCustomHost("pg-api.openai.com"), false);

      const enabledOnly = await listCustomHosts({ enabledOnly: true });
      assert.ok(!enabledOnly.some((h) => h.host === "pg-api.openai.com"));
      assert.ok(enabledOnly.some((h) => h.host === "pg-api.anthropic.com"));

      await touchLastSeen("pg-api.anthropic.com");
      const touched = (await listCustomHosts()).find((h) => h.host === "pg-api.anthropic.com");
      assert.ok(touched?.last_seen_at);

      await removeCustomHost("pg-api.openai.com");
      const afterRemove = await listCustomHosts();
      assert.ok(!afterRemove.some((h) => h.host === "pg-api.openai.com"));
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("inspector_custom_hosts")
        .where("host", "like", "pg-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
