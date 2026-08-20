import { getDbInstance } from "./core";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

export interface WebhookDelivery {
  id: number;
  webhook_id: string;
  event_type: string;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  payload_snapshot: string | null;
  created_at: string;
}

/** Safe projection for the deliveries list API — excludes `payload_snapshot`
 *  by default so audit-list responses never leak the captured request body. */
export type WebhookDeliverySafe = Omit<WebhookDelivery, "payload_snapshot">;

const MAX_DELIVERIES_PER_WEBHOOK = 100;

export async function insertDelivery(opts: {
  webhookId: string;
  eventType: string;
  status: string;
  httpStatus?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  payloadSnapshot?: string | null;
}): Promise<void> {
  // Sanitize the error before persistence so raw stack traces, hostnames or
  // upstream-internal messages never enter the audit log. The audit log is
  // read back via the deliveries API and rendered in the dashboard.
  const sanitizedError = opts.error != null ? sanitizeErrorMessage(opts.error) || null : null;

  if (resolveDbDriverConfig().driver === "postgres") {
    return insertDeliveryPostgres(opts, sanitizedError);
  }

  const db = getDbInstance();
  const insertStmt = db.prepare(
    `INSERT INTO webhook_deliveries
       (webhook_id, event_type, status, http_status, latency_ms, error, payload_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const rotateStmt = db.prepare(
    `DELETE FROM webhook_deliveries
     WHERE webhook_id = ?
       AND id NOT IN (
         SELECT id FROM webhook_deliveries
         WHERE webhook_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )`
  );
  db.transaction(() => {
    insertStmt.run(
      opts.webhookId,
      opts.eventType,
      opts.status,
      opts.httpStatus ?? null,
      opts.latencyMs ?? null,
      sanitizedError,
      opts.payloadSnapshot ?? null
    );
    rotateStmt.run(opts.webhookId, opts.webhookId, MAX_DELIVERIES_PER_WEBHOOK);
  })();
}

async function insertDeliveryPostgres(
  opts: {
    webhookId: string;
    eventType: string;
    status: string;
    httpStatus?: number | null;
    latencyMs?: number | null;
    payloadSnapshot?: string | null;
  },
  sanitizedError: string | null
): Promise<void> {
  await ensurePostgresBootstrap();
  const db = getKyselyDb();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("webhook_deliveries")
      .values({
        webhook_id: opts.webhookId,
        event_type: opts.eventType,
        status: opts.status,
        http_status: opts.httpStatus ?? null,
        latency_ms: opts.latencyMs ?? null,
        error: sanitizedError,
        payload_snapshot: opts.payloadSnapshot ?? null,
      })
      .execute();

    await trx
      .deleteFrom("webhook_deliveries")
      .where("webhook_id", "=", opts.webhookId)
      .where((eb) =>
        eb(
          "id",
          "not in",
          eb
            .selectFrom("webhook_deliveries")
            .select("id")
            .where("webhook_id", "=", opts.webhookId)
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .limit(MAX_DELIVERIES_PER_WEBHOOK)
        )
      )
      .execute();
  });
}

/** List recent deliveries excluding `payload_snapshot` (default — used by UI). */
export async function getDeliveries(
  webhookId: string,
  limit: number
): Promise<WebhookDeliverySafe[]> {
  if (resolveDbDriverConfig().driver === "postgres") {
    return getDeliveriesPostgres(webhookId, limit);
  }

  const db = getDbInstance();
  return db
    .prepare(
      `SELECT id, webhook_id, event_type, status, http_status, latency_ms, error, created_at
       FROM webhook_deliveries
       WHERE webhook_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(webhookId, limit) as WebhookDeliverySafe[];
}

async function getDeliveriesPostgres(
  webhookId: string,
  limit: number
): Promise<WebhookDeliverySafe[]> {
  await ensurePostgresBootstrap();
  const rows = await getKyselyDb()
    .selectFrom("webhook_deliveries")
    .select([
      "id",
      "webhook_id",
      "event_type",
      "status",
      "http_status",
      "latency_ms",
      "error",
      "created_at",
    ])
    .where("webhook_id", "=", webhookId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
  // node-postgres returns BIGINT columns (id, http_status, latency_ms) as
  // strings, not numbers — coerce to match the SQLite path's types.
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    http_status: row.http_status === null ? null : Number(row.http_status),
    latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
  })) as WebhookDeliverySafe[];
}
