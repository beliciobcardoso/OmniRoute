/** Persists and retrieves the model list synced from embedded services (9router, etc.). */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig.ts";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client.ts";

const NAMESPACE = "serviceModels";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

export interface ServiceModel {
  id: string;
  name?: string;
  object?: string;
  owned_by?: string;
  created?: number;
  available?: boolean;
  [key: string]: unknown;
}

export async function getServiceModels(tool: string): Promise<ServiceModel[]> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const row = await getKyselyDb()
      .selectFrom("key_value")
      .select("value")
      .where("namespace", "=", NAMESPACE)
      .where("key", "=", tool)
      .executeTakeFirst();
    if (!row?.value) return [];
    try {
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, tool) as { value: string } | undefined;
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persist a new model list for a tool, with soft-delete pruning.
 *
 * Models present in the new payload are UPSERTed with `available: true`.
 * Models that were previously stored but are missing from the new payload
 * are marked `available: false` (not deleted — preserves history).
 */
export async function saveServiceModels(tool: string, models: ServiceModel[]): Promise<void> {
  // Load existing stored models to compute the diff.
  const existing = await getServiceModels(tool);
  const incomingIds = new Set(models.map((m) => m.id));

  // Mark incoming models as available, and pruned ones as unavailable.
  const incomingWithFlag: ServiceModel[] = models.map((m) => ({ ...m, available: true }));
  const pruned: ServiceModel[] = existing
    .filter((m) => !incomingIds.has(m.id))
    .map((m) => ({ ...m, available: false }));

  const merged = [...incomingWithFlag, ...pruned];

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    if (merged.length === 0) {
      await getKyselyDb()
        .deleteFrom("key_value")
        .where("namespace", "=", NAMESPACE)
        .where("key", "=", tool)
        .execute();
    } else {
      await getKyselyDb()
        .insertInto("key_value")
        .values({ namespace: NAMESPACE, key: tool, value: JSON.stringify(merged) })
        .onConflict((oc) =>
          oc
            .columns(["namespace", "key"])
            .doUpdateSet((eb) => ({ value: eb.ref("excluded.value") }))
        )
        .execute();
    }
    return;
  }

  const db = getDbInstance();
  if (merged.length === 0) {
    db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(NAMESPACE, tool);
  } else {
    db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      NAMESPACE,
      tool,
      JSON.stringify(merged)
    );
  }
}

/**
 * Mark all stored models for a tool as unavailable.
 * Called when the supervisor transitions to stopped or error state so the
 * model catalog reflects that none of the models are currently reachable.
 */
export async function markAllUnavailable(tool: string): Promise<void> {
  const existing = await getServiceModels(tool);
  if (existing.length === 0) return;
  const updated: ServiceModel[] = existing.map((m) => ({ ...m, available: false }));

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    await getKyselyDb()
      .insertInto("key_value")
      .values({ namespace: NAMESPACE, key: tool, value: JSON.stringify(updated) })
      .onConflict((oc) =>
        oc.columns(["namespace", "key"]).doUpdateSet((eb) => ({ value: eb.ref("excluded.value") }))
      )
      .execute();
    return;
  }

  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    tool,
    JSON.stringify(updated)
  );
}
