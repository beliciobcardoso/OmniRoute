import test from "node:test";
import assert from "node:assert/strict";

import {
  recordProviderQuotaResetEventIfChanged,
  getProviderQuotaWindowStart,
  getProviderQuotaWindowStartIso,
} from "../../../src/lib/db/quotaResetEvents";
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
  "quotaResetEvents (postgres) record/dedup/window-start lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const connectionId = "pg-quota-reset-conn";
    const prevReset = "2026-06-25T23:00:00.000Z";
    const currReset = "2026-07-02T23:00:00.000Z";
    const observedAt = "2026-06-25T23:04:00.000Z";

    try {
      await recordProviderQuotaResetEventIfChanged({
        provider: "claude",
        connectionId,
        windowKey: "weekly (7d)",
        currentResetAt: currReset,
        currentRemainingPercentage: 100,
        previousObservation: { resetAt: prevReset, remainingPercentage: 0 },
        observedAt,
      });

      // Re-recording the exact same transition must be a no-op (ON CONFLICT DO NOTHING).
      await recordProviderQuotaResetEventIfChanged({
        provider: "claude",
        connectionId,
        windowKey: "weekly (7d)",
        currentResetAt: currReset,
        currentRemainingPercentage: 100,
        previousObservation: { resetAt: prevReset, remainingPercentage: 0 },
        observedAt,
      });

      const kdb = getKyselyDb();
      const rows = await kdb
        .selectFrom("provider_quota_reset_events")
        .selectAll()
        .where("connection_id", "=", connectionId)
        .execute();
      assert.equal(
        rows.length,
        1,
        "duplicate reset event must be deduplicated by the unique constraint"
      );

      const start = await getProviderQuotaWindowStart(
        connectionId,
        currReset,
        Date.parse("2026-07-02T00:00:00.000Z")
      );
      assert.equal(start?.windowStartIso, prevReset);
      assert.equal(start?.source, "recorded_reset_event");

      const startIso = await getProviderQuotaWindowStartIso(
        connectionId,
        currReset,
        Date.parse("2026-07-02T00:00:00.000Z")
      );
      assert.equal(startIso, prevReset);
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("provider_quota_reset_events")
        .where("connection_id", "=", connectionId)
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
