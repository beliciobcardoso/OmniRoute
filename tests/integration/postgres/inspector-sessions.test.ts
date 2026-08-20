import test from "node:test";
import assert from "node:assert/strict";

import {
  createSession,
  stopSession,
  renameSession,
  listSessions,
  getSession,
  appendSessionRequest,
  getSessionRequests,
  deleteSession,
  snapshotSession,
} from "../../../src/lib/db/inspectorSessions";
import { ensurePostgresBootstrap, resetKyselyDb } from "../../../src/lib/db/kysely/client";

function makeValidInterceptedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: crypto.randomUUID(),
    source: "agent-bridge",
    timestamp: new Date().toISOString(),
    method: "POST",
    host: "api.example.com",
    path: "/v1/chat/completions",
    requestHeaders: { "content-type": "application/json" },
    requestBody: null,
    requestSize: 0,
    responseHeaders: {},
    responseBody: null,
    responseSize: 0,
    status: 200,
    ...overrides,
  });
}

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "inspectorSessions (postgres) creates, records requests, and cascades deletes",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const { id, started_at } = await createSession({ name: "PG Session", profile: "llm" });

    try {
      assert.ok(id);
      assert.ok(Date.parse(started_at) > 0);

      const created = await getSession(id);
      assert.equal(created?.name, "PG Session");
      assert.equal(created?.profile, "llm");
      assert.equal(created?.ended_at, null);
      assert.equal(created?.request_count, 0);

      const sessions = await listSessions();
      assert.ok(sessions.some((s) => s.id === id));

      const seq1 = await appendSessionRequest(id, makeValidInterceptedPayload({ path: "/req-1" }));
      const seq2 = await appendSessionRequest(id, makeValidInterceptedPayload({ path: "/req-2" }));
      assert.equal(seq1, 1);
      assert.equal(seq2, 2);

      const afterAppend = await getSession(id);
      assert.equal(afterAppend?.request_count, 2);

      const requests = await getSessionRequests(id);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].seq, 1);
      assert.equal(requests[1].seq, 2);

      const snapshot = await snapshotSession(id);
      assert.ok(snapshot !== null);
      assert.equal(snapshot.length, 2);
      assert.equal(snapshot[0].path, "/req-1");
      assert.equal(snapshot[1].path, "/req-2");

      await renameSession(id, "Renamed PG Session");
      assert.equal((await getSession(id))?.name, "Renamed PG Session");

      await stopSession(id);
      const stopped = await getSession(id);
      assert.ok(stopped?.ended_at !== null);
      assert.ok(Date.parse(stopped?.ended_at as string) > 0);

      assert.equal(await snapshotSession("00000000-0000-4000-8000-000000000000"), null);

      await deleteSession(id);
      assert.equal(await getSession(id), null);
      assert.deepEqual(await getSessionRequests(id), []);
    } finally {
      await deleteSession(id).catch(() => {});
      await resetKyselyDb();
    }
  }
);
