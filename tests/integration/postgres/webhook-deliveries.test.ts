import test from "node:test";
import assert from "node:assert/strict";

import { getDeliveries, insertDelivery } from "../../../src/lib/db/webhookDeliveries";
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
  "webhookDeliveries (postgres) inserts, lists, and rotates deliveries per webhook",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const webhookId = `pg-test-webhook-${Date.now()}`;
    try {
      await insertDelivery({
        webhookId,
        eventType: "request.failed",
        status: "delivered",
        httpStatus: 200,
        latencyMs: 142,
        payloadSnapshot: JSON.stringify({ event: "request.failed" }),
      });

      const rows = await getDeliveries(webhookId, 10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].event_type, "request.failed");
      assert.equal(rows[0].http_status, 200);
      assert.equal(rows[0].status, "delivered");
      assert.equal("payload_snapshot" in rows[0], false);

      for (let i = 0; i < 105; i++) {
        await insertDelivery({
          webhookId,
          eventType: "test.ping",
          status: "delivered",
          httpStatus: 200,
          latencyMs: 10,
        });
      }
      const rotated = await getDeliveries(webhookId, 200);
      assert.equal(rotated.length, 100);

      const limited = await getDeliveries(webhookId, 5);
      assert.equal(limited.length, 5);
    } finally {
      await getKyselyDb()
        .deleteFrom("webhook_deliveries")
        .where("webhook_id", "=", webhookId)
        .execute();
      await resetKyselyDb();
    }
  }
);
