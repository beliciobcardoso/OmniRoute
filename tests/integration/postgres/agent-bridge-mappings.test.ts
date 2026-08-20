import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteMapping,
  getMappingsForAgent,
  setMappings,
} from "../../../src/lib/db/agentBridgeMappings";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "agentBridgeMappings (postgres) sets, reads, replaces, and deletes per-agent mappings",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const agentId = `pg-test-agent-${Date.now()}`;
    try {
      assert.deepEqual(await getMappingsForAgent(agentId), []);

      await setMappings(agentId, [
        { source: "gpt-4", target: "openai/gpt-4.1" },
        { source: "gpt-3.5-turbo", target: "openai/gpt-4o-mini" },
      ]);
      const rows = await getMappingsForAgent(agentId);
      assert.equal(rows.length, 2);
      const gpt4Row = rows.find((r) => r.source_model === "gpt-4");
      assert.equal(gpt4Row?.target_model, "openai/gpt-4.1");

      // setMappings replaces rather than accumulates.
      await setMappings(agentId, [{ source: "claude-3-opus", target: "anthropic/claude-opus-4" }]);
      const replaced = await getMappingsForAgent(agentId);
      assert.equal(replaced.length, 1);
      assert.equal(replaced[0].source_model, "claude-3-opus");

      await deleteMapping(agentId, "claude-3-opus");
      assert.deepEqual(await getMappingsForAgent(agentId), []);
    } finally {
      await setMappings(agentId, []);
      await resetKyselyDb();
    }
  }
);
