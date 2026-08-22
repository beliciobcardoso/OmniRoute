import test from "node:test";
import assert from "node:assert/strict";

import {
  getAllAgentBridgeStates,
  getAgentBridgeState,
  upsertAgentBridgeState,
  setLastStarted,
  setLastError,
} from "../../../src/lib/db/agentBridgeState";
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
  "agentBridgeState (postgres) upsert/get/setLastStarted/setLastError lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      assert.equal(await getAgentBridgeState("pg-copilot"), null);

      await upsertAgentBridgeState({ agent_id: "pg-copilot" });
      const created = await getAgentBridgeState("pg-copilot");
      assert.ok(created);
      assert.equal(created.dns_enabled, false);
      assert.equal(created.cert_trusted, false);
      assert.equal(created.setup_completed, false);

      await upsertAgentBridgeState({
        agent_id: "pg-copilot",
        dns_enabled: true,
        cert_trusted: true,
      });
      const updated = await getAgentBridgeState("pg-copilot");
      assert.equal(updated?.dns_enabled, true);
      assert.equal(updated?.cert_trusted, true);
      assert.equal(updated?.setup_completed, false);

      const ts = new Date().toISOString();
      await setLastStarted("pg-cursor", ts);
      assert.equal((await getAgentBridgeState("pg-cursor"))?.last_started_at, ts);

      await setLastError("pg-copilot", "upstream timeout");
      assert.equal((await getAgentBridgeState("pg-copilot"))?.last_error, "upstream timeout");
      await setLastError("pg-copilot", null);
      assert.equal((await getAgentBridgeState("pg-copilot"))?.last_error, null);

      const all = await getAllAgentBridgeStates();
      const ids = all.map((r) => r.agent_id);
      assert.ok(ids.includes("pg-copilot"));
      assert.ok(ids.includes("pg-cursor"));
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("agent_bridge_state")
        .where("agent_id", "like", "pg-%")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
