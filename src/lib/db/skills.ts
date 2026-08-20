/**
 * db/skills.ts — Database operations for the skills table.
 *
 * Encapsulates all SQL for the `skills` and `skill_executions` tables so that
 * route handlers never contain raw SQL (Hard Rule #5).
 */

import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

// ──────────────── Allowed patch columns ────────────────
//
// updateSkill builds a SET clause dynamically. To prevent SQL injection the
// column names are validated against this allowlist of known, writable columns.
// Any key in the patch that is NOT in this set is silently ignored.
const UPDATABLE_COLUMNS = new Set<string>([
  "enabled",
  "mode",
  "updated_at",
  // future-safe: add writable columns here as schema grows
]);

export interface SkillPatch {
  enabled?: number | boolean;
  mode?: string;
}

/**
 * Update a skill row with a parameterized, injection-safe dynamic SET clause.
 *
 * @param id   - Row ID of the skill to update.
 * @param patch - Plain-object of column→value pairs to apply.
 *               Only columns present in UPDATABLE_COLUMNS are touched;
 *               unknown keys are silently ignored.
 *
 * The function always appends `updated_at = datetime('now')` so the record's
 * timestamp reflects the mutation.
 *
 * @returns number of rows changed (0 if skill not found, 1 if updated).
 */
export async function updateSkill(id: string, patch: SkillPatch): Promise<number> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();

    const setValues: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!UPDATABLE_COLUMNS.has(key)) continue; // allowlist guard
      // `enabled` is BIGINT in Postgres — coerce booleans to 0/1.
      setValues[key] = key === "enabled" ? (value ? 1 : 0) : value;
    }

    if (Object.keys(setValues).length === 0) {
      // Nothing to update (all keys were filtered out).
      return 0;
    }

    setValues.updated_at = new Date().toISOString();

    const result = await getKyselyDb()
      .updateTable("skills")
      .set(setValues)
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  const db = getDbInstance();

  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!UPDATABLE_COLUMNS.has(key)) continue; // allowlist guard
    setClauses.push(`${key} = ?`);
    params.push(value);
  }

  if (setClauses.length === 0) {
    // Nothing to update (all keys were filtered out).
    return 0;
  }

  setClauses.push("updated_at = datetime('now')");
  params.push(id);

  const result = db
    .prepare(`UPDATE skills SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...params);
  return (result as { changes: number }).changes;
}
