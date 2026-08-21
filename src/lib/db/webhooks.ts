/**
 * Database module: Webhooks
 * CRUD operations for webhook event subscriptions
 */

import { getDbInstance } from "./core";
import crypto from "crypto";
import { sql } from "kysely";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export type WebhookKind = "slack" | "telegram" | "discord" | "custom";

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  enabled: boolean;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: WebhookKind;
  metadata_encrypted: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string | null;
  enabled: number;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: string;
  metadata_encrypted: string | null;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    ...row,
    kind: (row.kind as WebhookKind) || "custom",
    events: JSON.parse(row.events || '["*"]'),
    enabled: row.enabled === 1,
  };
}

/** node-postgres returns BIGINT columns (enabled/last_status/failure_count) as strings. */
function pgNormalizeRow(row: Record<string, unknown>): WebhookRow {
  return {
    ...row,
    enabled: Number(row.enabled),
    last_status: row.last_status === null ? null : Number(row.last_status),
    failure_count: Number(row.failure_count),
  } as WebhookRow;
}

export async function getWebhooks(): Promise<Webhook[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("webhooks")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => rowToWebhook(pgNormalizeRow(row)));
  }

  const db = getDbInstance();
  const rows = db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all() as WebhookRow[];
  return rows.map(rowToWebhook);
}

export async function getWebhook(id: string): Promise<Webhook | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("webhooks")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToWebhook(pgNormalizeRow(row)) : null;
  }

  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : null;
}

export async function getEnabledWebhooks(): Promise<Webhook[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const rows = await getKyselyDb()
      .selectFrom("webhooks")
      .selectAll()
      .where("enabled", "=", 1)
      .execute();
    return rows.map((row) => rowToWebhook(pgNormalizeRow(row)));
  }

  const db = getDbInstance();
  const rows = db.prepare("SELECT * FROM webhooks WHERE enabled = 1").all() as WebhookRow[];
  return rows.map(rowToWebhook);
}

export async function createWebhook(data: {
  url: string;
  events?: string[];
  secret?: string;
  description?: string;
  kind?: WebhookKind;
  metadataEncrypted?: string | null;
}): Promise<Webhook> {
  const id = crypto.randomUUID();
  const secret = data.secret || `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const kind = data.kind || "custom";
  const events = JSON.stringify(data.events || ["*"]);
  const description = data.description || "";
  const metadataEncrypted = data.metadataEncrypted ?? null;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("webhooks")
      .values({
        id,
        url: data.url,
        events,
        secret,
        description,
        kind,
        metadata_encrypted: metadataEncrypted,
      })
      .execute();
    return (await getWebhook(id))!;
  }

  const db = getDbInstance();
  db.prepare(
    `INSERT INTO webhooks (id, url, events, secret, description, kind, metadata_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, data.url, events, secret, description, kind, metadataEncrypted);

  return (await getWebhook(id))!;
}

export async function updateWebhook(
  id: string,
  data: Partial<{
    url: string;
    events: string[];
    secret: string;
    enabled: boolean;
    description: string;
    kind: WebhookKind;
    metadataEncrypted: string | null;
  }>
): Promise<Webhook | null> {
  const existing = await getWebhook(id);
  if (!existing) return null;

  if (isPostgres()) {
    const set: Record<string, unknown> = {};
    if (data.url !== undefined) set.url = data.url;
    if (data.events !== undefined) set.events = JSON.stringify(data.events);
    if (data.secret !== undefined) set.secret = data.secret;
    if (data.enabled !== undefined) set.enabled = data.enabled ? 1 : 0;
    if (data.description !== undefined) set.description = data.description;
    if (data.kind !== undefined) set.kind = data.kind;
    if (data.metadataEncrypted !== undefined) set.metadata_encrypted = data.metadataEncrypted;

    if (Object.keys(set).length === 0) return existing;

    await ensurePostgresBootstrap();
    await getKyselyDb()
      .updateTable("webhooks")
      .set(set as any)
      .where("id", "=", id)
      .execute();
    return getWebhook(id);
  }

  const db = getDbInstance();
  const fields: string[] = [];
  const values: any[] = [];

  if (data.url !== undefined) {
    fields.push("url = ?");
    values.push(data.url);
  }
  if (data.events !== undefined) {
    fields.push("events = ?");
    values.push(JSON.stringify(data.events));
  }
  if (data.secret !== undefined) {
    fields.push("secret = ?");
    values.push(data.secret);
  }
  if (data.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(data.enabled ? 1 : 0);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.kind !== undefined) {
    fields.push("kind = ?");
    values.push(data.kind);
  }
  if (data.metadataEncrypted !== undefined) {
    fields.push("metadata_encrypted = ?");
    values.push(data.metadataEncrypted);
  }

  if (fields.length === 0) return existing;

  values.push(id);
  db.prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  return getWebhook(id);
}

export async function deleteWebhook(id: string): Promise<boolean> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .deleteFrom("webhooks")
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  const db = getDbInstance();
  const result = db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  return (result as any).changes > 0;
}

export async function recordWebhookDelivery(
  id: string,
  status: number,
  success: boolean
): Promise<void> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    if (success) {
      await getKyselyDb()
        .updateTable("webhooks")
        .set({ last_triggered_at: sql`now()`, last_status: status, failure_count: 0 })
        .where("id", "=", id)
        .execute();
    } else {
      await getKyselyDb()
        .updateTable("webhooks")
        .set((eb) => ({
          last_triggered_at: sql`now()`,
          last_status: status,
          failure_count: eb("failure_count", "+", 1),
        }))
        .where("id", "=", id)
        .execute();
    }
    return;
  }

  const db = getDbInstance();
  if (success) {
    db.prepare(
      `UPDATE webhooks SET last_triggered_at = datetime('now'), last_status = ?, failure_count = 0 WHERE id = ?`
    ).run(status, id);
  } else {
    db.prepare(
      `UPDATE webhooks SET last_triggered_at = datetime('now'), last_status = ?, failure_count = failure_count + 1 WHERE id = ?`
    ).run(status, id);
  }
}

export async function disableWebhooksWithHighFailures(threshold = 10): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const result = await getKyselyDb()
      .updateTable("webhooks")
      .set({ enabled: 0 })
      .where("failure_count", ">=", threshold)
      .where("enabled", "=", 1)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  const db = getDbInstance();
  const result = db
    .prepare(`UPDATE webhooks SET enabled = 0 WHERE failure_count >= ? AND enabled = 1`)
    .run(threshold);
  return (result as any).changes;
}
