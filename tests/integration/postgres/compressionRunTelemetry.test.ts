import test from "node:test";
import assert from "node:assert/strict";

import {
  insertCompressionRunTelemetryRow,
  getCompressionRunTelemetrySummary,
} from "../../../src/lib/db/compressionRunTelemetry";
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
  "compressionRunTelemetry (postgres) insert/summarize lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    try {
      await insertCompressionRunTelemetryRow({
        requestId: "pg-req-1",
        model: "gpt-4o",
        provider: "openai",
        source: "active-profile",
        tokensBefore: 1000,
        tokensAfter: 700,
        ratio: 0.7,
        outputStyles: [{ id: "terse-prose", level: "full" }],
        outputTokens: 320,
      });
      await insertCompressionRunTelemetryRow({
        requestId: "pg-req-2",
        model: "gpt-4o",
        provider: "openai",
        source: "default",
        tokensBefore: 500,
        tokensAfter: 500,
        ratio: 1,
        outputStyleBypass: "security_warning",
      });

      const summary = await getCompressionRunTelemetrySummary();
      assert.equal(summary.totalRuns, 2);
      assert.equal(summary.totalTokensSaved, 300);
      assert.equal(summary.runsWithStyles, 1);
      assert.equal(summary.bypassCount, 1);
      assert.deepEqual(summary.appliedStyleCounts, { "terse-prose": 1 });
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("compression_run_telemetry")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
