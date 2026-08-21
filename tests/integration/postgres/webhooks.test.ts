import test from "node:test";
import assert from "node:assert/strict";

import {
  getWebhooks,
  getWebhook,
  getEnabledWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  recordWebhookDelivery,
  disableWebhooksWithHighFailures,
} from "../../../src/lib/db/webhooks";
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
  "webhooks (postgres) create/update/enabled/delivery/disable round trip",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const url = `https://example.com/hook-${Date.now()}`;
    let webhookId: string | null = null;
    let secondId: string | null = null;

    try {
      const created = await createWebhook({
        url,
        events: ["request.completed"],
        description: "pg test webhook",
      });
      webhookId = created.id;
      assert.match(created.secret!, /^whsec_/);
      assert.equal(created.enabled, true);
      assert.equal(created.kind, "custom");

      const fetched = await getWebhook(created.id);
      assert.equal(fetched!.url, url);

      const all = await getWebhooks();
      assert.ok(all.some((w) => w.id === created.id));

      const enabledBefore = await getEnabledWebhooks();
      assert.ok(enabledBefore.some((w) => w.id === created.id));

      const updated = await updateWebhook(created.id, {
        kind: "telegram",
        metadataEncrypted: "enc:v1:test",
        enabled: false,
      });
      assert.equal(updated!.kind, "telegram");
      assert.equal(updated!.metadata_encrypted, "enc:v1:test");
      assert.equal(updated!.enabled, false);

      const enabledAfter = await getEnabledWebhooks();
      assert.ok(!enabledAfter.some((w) => w.id === created.id));

      // Re-enable for the delivery/disable-threshold test.
      await updateWebhook(created.id, { enabled: true });

      await recordWebhookDelivery(created.id, 500, false);
      await recordWebhookDelivery(created.id, 502, false);
      let afterFailures = await getWebhook(created.id);
      assert.equal(afterFailures!.failure_count, 2);
      assert.equal(afterFailures!.last_status, 502);

      await recordWebhookDelivery(created.id, 200, true);
      afterFailures = await getWebhook(created.id);
      assert.equal(afterFailures!.failure_count, 0);
      assert.equal(afterFailures!.last_status, 200);
      assert.ok(afterFailures!.last_triggered_at);

      // Second webhook stays under the failure threshold.
      const second = await createWebhook({ url: `${url}-second` });
      secondId = second.id;
      for (let i = 0; i < 3; i++) {
        await recordWebhookDelivery(created.id, 500, false);
      }
      await recordWebhookDelivery(second.id, 500, false);

      const disabledCount = await disableWebhooksWithHighFailures(2);
      assert.equal(disabledCount, 1);
      assert.equal((await getWebhook(created.id))!.enabled, false);
      assert.equal((await getWebhook(second.id))!.enabled, true);

      const deleted = await deleteWebhook(created.id);
      assert.equal(deleted, true);
      assert.equal(await getWebhook(created.id), null);
      const deletedAgain = await deleteWebhook(created.id);
      assert.equal(deletedAgain, false);
      webhookId = null;
    } finally {
      for (const id of [webhookId, secondId]) {
        if (!id) continue;
        await getKyselyDb()
          .deleteFrom("webhooks")
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
