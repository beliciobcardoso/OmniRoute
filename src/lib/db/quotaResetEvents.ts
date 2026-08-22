import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

interface QuotaObservation {
  resetAt: string | null;
  remainingPercentage: number | null;
}

interface ResetEventInput {
  provider: string;
  connectionId: string;
  windowKey: string;
  currentResetAt: string | null;
  currentRemainingPercentage: number | null;
  previousObservation?: QuotaObservation | null;
  observedAt?: string;
}

interface ResetEventWindowRow {
  windowStartedAt: string;
  windowResetsAt: string;
  observedAt: string;
}

interface QuotaSnapshotObservationRow {
  nextResetAt: string | null;
  remainingPercentage: number | null;
}

interface QuotaSnapshotWindowRow {
  nextResetAt: string | null;
  remainingPercentage: number | null;
  createdAt: string | null;
}

export interface ProviderQuotaWindowStart {
  windowStartIso: string;
  source: "recorded_reset_event" | "observed_snapshot_reset";
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function usedPercent(remainingPercentage: number | null): number | null {
  const remaining = clampPercent(remainingPercentage);
  return remaining === null ? null : Math.max(0, Math.min(100, 100 - remaining));
}

function isResetDrop(
  previousUsedPercentage: number | null,
  currentUsedPercentage: number
): boolean {
  if (previousUsedPercentage === null) return false;
  const droppedToResetFloor =
    currentUsedPercentage <= 1 && previousUsedPercentage > currentUsedPercentage;
  const significantDrop = previousUsedPercentage - currentUsedPercentage >= 5;
  return droppedToResetFloor || significantDrop;
}

function parseResetIso(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function resetDay(value: string | null): string | null {
  const iso = parseResetIso(value);
  return iso ? iso.slice(0, 10) : null;
}

function normalizeWindowKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isPrimaryWeeklyWindow(windowKey: string): boolean {
  const normalized = normalizeWindowKey(windowKey);
  return (
    (normalized.includes("weekly") || normalized.includes("7d")) && !normalized.includes("sonnet")
  );
}

async function getLatestSnapshotObservation(
  connectionId: string,
  windowKey: string
): Promise<QuotaObservation | null> {
  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const row = await kdb
      .selectFrom("quota_snapshots")
      .select(["next_reset_at", "remaining_percentage"])
      .where("connection_id", "=", connectionId)
      .where(({ fn, eb }) => eb(fn("lower", ["window_key"]), "=", windowKey.toLowerCase()))
      .where("next_reset_at", "is not", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return {
      resetAt: row.next_reset_at ?? null,
      remainingPercentage: toNumberOrNull(row.remaining_percentage),
    };
  }

  const db = getDbInstance() as unknown as DbLike;
  try {
    const row = db
      .prepare<QuotaSnapshotObservationRow>(
        `
        SELECT
          next_reset_at as nextResetAt,
          remaining_percentage as remainingPercentage
        FROM quota_snapshots
        WHERE connection_id = ?
          AND LOWER(window_key) = LOWER(?)
          AND next_reset_at IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      )
      .get(connectionId, windowKey);
    if (!row) return null;
    return {
      resetAt: row.nextResetAt,
      remainingPercentage: toNumberOrNull(row.remainingPercentage),
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("no such table")) return null;
    throw error;
  }
}

export async function recordProviderQuotaResetEventIfChanged(
  input: ResetEventInput
): Promise<void> {
  if (!input.connectionId || !input.windowKey || !isPrimaryWeeklyWindow(input.windowKey)) return;

  const currentResetIso = parseResetIso(input.currentResetAt);
  if (!currentResetIso) return;

  const previous =
    input.previousObservation ??
    (await getLatestSnapshotObservation(input.connectionId, input.windowKey));
  const previousResetIso = parseResetIso(previous?.resetAt ?? null);
  if (!previousResetIso) return;

  const previousResetMs = Date.parse(previousResetIso);
  const currentResetMs = Date.parse(currentResetIso);
  if (!Number.isFinite(previousResetMs) || !Number.isFinite(currentResetMs)) return;

  const previousRemaining = clampPercent(toNumberOrNull(previous?.remainingPercentage));
  const currentRemaining = clampPercent(toNumberOrNull(input.currentRemainingPercentage));
  const observedAt = parseResetIso(input.observedAt ?? null) ?? new Date().toISOString();
  const previousUsed = usedPercent(previousRemaining);
  const currentUsed = usedPercent(currentRemaining);
  const resetMovedForward =
    currentResetMs > previousResetMs && resetDay(previousResetIso) !== resetDay(currentResetIso);
  const resetObservedWithinSameResetAt =
    resetDay(previousResetIso) === resetDay(currentResetIso) &&
    currentUsed !== null &&
    isResetDrop(previousUsed, currentUsed);

  if (!resetMovedForward && !resetObservedWithinSameResetAt) return;

  const windowStartedAt = resetMovedForward ? previousResetIso : observedAt;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    await kdb
      .insertInto("provider_quota_reset_events")
      .values({
        provider: input.provider,
        connection_id: input.connectionId,
        window_key: input.windowKey,
        window_started_at: windowStartedAt,
        window_resets_at: currentResetIso,
        observed_at: observedAt,
        previous_remaining_percentage: previousRemaining,
        new_remaining_percentage: currentRemaining,
        previous_used_percentage: previousUsed,
        new_used_percentage: currentUsed,
        raw_data: null,
      })
      .onConflict((oc) =>
        oc
          .columns(["connection_id", "window_key", "window_started_at", "window_resets_at"])
          .doNothing()
      )
      .execute();
    return;
  }

  try {
    const db = getDbInstance() as unknown as DbLike;
    db.prepare(
      `
      INSERT OR IGNORE INTO provider_quota_reset_events
        (provider, connection_id, window_key, window_started_at, window_resets_at,
         observed_at, previous_remaining_percentage, new_remaining_percentage,
         previous_used_percentage, new_used_percentage, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      input.provider,
      input.connectionId,
      input.windowKey,
      windowStartedAt,
      currentResetIso,
      observedAt,
      previousRemaining,
      currentRemaining,
      previousUsed,
      currentUsed,
      null
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("no such table")) return;
    throw error;
  }
}

async function getRecordedQuotaWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs = Date.now()
): Promise<string | null> {
  if (!connectionId || !targetResetAtIso) return null;
  const targetDay = resetDay(targetResetAtIso);
  if (!targetDay) return null;

  const nowIso = new Date(nowMs).toISOString();

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const rows = await kdb
      .selectFrom("provider_quota_reset_events")
      .select(["window_started_at", "window_resets_at", "observed_at"])
      .where("connection_id", "=", connectionId)
      .where("observed_at", "<=", nowIso)
      .orderBy("observed_at", "desc")
      .execute();

    for (const row of rows) {
      if (resetDay(row.window_resets_at) !== targetDay) continue;
      return parseResetIso(row.window_started_at);
    }
    return null;
  }

  const db = getDbInstance() as unknown as DbLike;
  try {
    const rows = db
      .prepare<ResetEventWindowRow>(
        `
        SELECT
          window_started_at as windowStartedAt,
          window_resets_at as windowResetsAt,
          observed_at as observedAt
        FROM provider_quota_reset_events
        WHERE connection_id = ?
          AND observed_at <= ?
        ORDER BY observed_at DESC
      `
      )
      .all(connectionId, nowIso);

    for (const row of rows) {
      if (resetDay(row.windowResetsAt) !== targetDay) continue;
      return parseResetIso(row.windowStartedAt);
    }
    return null;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("no such table")) return null;
    throw error;
  }
}

async function getObservedQuotaWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs = Date.now()
): Promise<{ windowStartIso: string; resetDrop: boolean } | null> {
  if (!connectionId || !targetResetAtIso) return null;
  const targetDay = resetDay(targetResetAtIso);
  if (!targetDay) return null;

  const nowIso = new Date(nowMs).toISOString();

  let rows: QuotaSnapshotWindowRow[];

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const pgRows = await kdb
      .selectFrom("quota_snapshots")
      .select(["next_reset_at", "remaining_percentage", "created_at"])
      .where("connection_id", "=", connectionId)
      .where(({ fn, eb }) => eb(fn("lower", ["window_key"]), "like", "%weekly%"))
      .where(({ fn, eb }) => eb(fn("lower", ["window_key"]), "not like", "%sonnet%"))
      .where("created_at", "<=", nowIso)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    rows = pgRows.map((r) => ({
      nextResetAt: r.next_reset_at ?? null,
      remainingPercentage: toNumberOrNull(r.remaining_percentage),
      createdAt: r.created_at ?? null,
    }));
  } else {
    const db = getDbInstance() as unknown as DbLike;
    try {
      rows = db
        .prepare<QuotaSnapshotWindowRow>(
          `
          SELECT
            next_reset_at as nextResetAt,
            remaining_percentage as remainingPercentage,
            created_at as createdAt
          FROM quota_snapshots
          WHERE connection_id = @connectionId
            AND LOWER(window_key) LIKE '%weekly%'
            AND LOWER(window_key) NOT LIKE '%sonnet%'
            AND created_at <= @nowIso
          ORDER BY created_at ASC, id ASC
        `
        )
        .all({ connectionId, nowIso });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("no such table")) return null;
      throw error;
    }
  }

  let firstObservedIso: string | null = null;
  let resetDropIso: string | null = null;
  let previousUsedPercentage: number | null = null;

  for (const row of rows) {
    const createdIso = parseResetIso(row.createdAt);
    if (!createdIso || resetDay(row.nextResetAt) !== targetDay) continue;

    if (!firstObservedIso) firstObservedIso = createdIso;

    const currentUsedPercentage = usedPercent(clampPercent(row.remainingPercentage));
    if (currentUsedPercentage !== null) {
      if (isResetDrop(previousUsedPercentage, currentUsedPercentage)) {
        resetDropIso = createdIso;
      }
      previousUsedPercentage = currentUsedPercentage;
    }
  }

  if (resetDropIso) return { windowStartIso: resetDropIso, resetDrop: true };
  if (firstObservedIso) return { windowStartIso: firstObservedIso, resetDrop: false };
  return null;
}

export async function getProviderQuotaWindowStart(
  connectionId: string,
  targetResetAtIso: string,
  nowMs = Date.now()
): Promise<ProviderQuotaWindowStart | null> {
  const recordedIso = await getRecordedQuotaWindowStartIso(connectionId, targetResetAtIso, nowMs);
  const observed = await getObservedQuotaWindowStartIso(connectionId, targetResetAtIso, nowMs);

  if (!recordedIso && !observed) return null;
  if (!recordedIso && observed) {
    return { windowStartIso: observed.windowStartIso, source: "observed_snapshot_reset" };
  }
  if (recordedIso && !observed) {
    return { windowStartIso: recordedIso, source: "recorded_reset_event" };
  }

  const recordedMs = Date.parse(recordedIso!);
  const observedMs = Date.parse(observed!.windowStartIso);
  if (
    observed!.resetDrop &&
    Number.isFinite(recordedMs) &&
    Number.isFinite(observedMs) &&
    observedMs > recordedMs
  ) {
    return { windowStartIso: observed!.windowStartIso, source: "observed_snapshot_reset" };
  }

  return { windowStartIso: recordedIso!, source: "recorded_reset_event" };
}

export async function getProviderQuotaWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs = Date.now()
): Promise<string | null> {
  const result = await getProviderQuotaWindowStart(connectionId, targetResetAtIso, nowMs);
  return result?.windowStartIso ?? null;
}
