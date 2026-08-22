import test from "node:test";
import assert from "node:assert/strict";

import {
  saveRequestDetailLog,
  getRequestDetailLogs,
  getRequestDetailLogById,
  getRequestDetailLogByCallLogId,
  getRequestDetailLogCount,
} from "../../../src/lib/db/detailedLogs";
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
  "detailedLogs (postgres) save/list/get/count lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      await saveRequestDetailLog({
        id: "pg-detail-older",
        call_log_id: "pg-call-1",
        timestamp: "2026-04-05T18:00:00.000Z",
        client_request: { hello: "world" },
        provider: "openai",
        model: "gpt-4.1",
        duration_ms: 100,
      });
      await saveRequestDetailLog({
        id: "pg-detail-newer",
        call_log_id: "pg-call-1",
        timestamp: "2026-04-05T18:00:05.000Z",
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        duration_ms: 200,
      });

      const byId = await getRequestDetailLogById("pg-detail-older");
      assert.equal(byId?.provider, "openai");
      assert.deepEqual(byId?.client_request, { hello: "world" });

      const byCallLog = await getRequestDetailLogByCallLogId("pg-call-1");
      assert.equal(byCallLog?.id, "pg-detail-newer");

      const list = await getRequestDetailLogs(10, 0);
      const ids = list.map((r) => r.id);
      assert.ok(ids.includes("pg-detail-older"));
      assert.ok(ids.includes("pg-detail-newer"));

      const count = await getRequestDetailLogCount();
      assert.ok(count >= 2);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("request_detail_logs")
        .where("call_log_id", "=", "pg-call-1")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
