import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export interface CompressionRunTelemetryInput {
  requestId: string;
  model: string;
  provider: string;
  source: string;
  tokensBefore: number;
  tokensAfter: number;
  ratio: number;
  costDelta?: number;
  outputStyles?: Array<{ id: string; level: "lite" | "full" | "ultra" }>;
  outputStyleBypass?: string;
  outputTokens?: number;
}

export interface CompressionRunTelemetrySummary {
  totalRuns: number;
  totalTokensSaved: number;
  runsWithStyles: number;
  bypassCount: number;
  totalOutputTokens: number;
  appliedStyleCounts: Record<string, number>;
}

function ensureCompressionRunTelemetryTable(): void {
  const db = getDbInstance();
  // `CREATE TABLE IF NOT EXISTS` is idempotent and cheap; run it unconditionally so the
  // table exists even if the migration that would normally create it hasn't run yet.
  db.exec(`
    CREATE TABLE IF NOT EXISTS compression_run_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      request_id TEXT,
      model TEXT,
      provider TEXT,
      source TEXT,
      tokens_before INTEGER NOT NULL,
      tokens_after INTEGER NOT NULL,
      ratio REAL,
      cost_delta REAL,
      output_styles TEXT,
      output_style_bypass TEXT,
      output_tokens INTEGER
    )
  `);
}

/**
 * Persist one CompressionRunTelemetry record (D0). Best-effort and off the hot path:
 * the `timestamp` is stamped here (never inside the pure resolvers). Mirrors the
 * compression-stats / compressionAnalytics recording discipline — never throws into a request.
 */
export async function insertCompressionRunTelemetryRow(
  row: CompressionRunTelemetryInput
): Promise<void> {
  try {
    if (isPostgres()) {
      await ensurePostgresBootstrap();
      const kdb = getKyselyDb();
      await kdb
        .insertInto("compression_run_telemetry")
        .values({
          timestamp: Date.now(),
          request_id: row.requestId ?? null,
          model: row.model ?? null,
          provider: row.provider ?? null,
          source: row.source ?? null,
          tokens_before: row.tokensBefore,
          tokens_after: row.tokensAfter,
          ratio: row.ratio,
          cost_delta: row.costDelta ?? null,
          output_styles:
            row.outputStyles && row.outputStyles.length > 0
              ? JSON.stringify(row.outputStyles)
              : null,
          output_style_bypass: row.outputStyleBypass ?? null,
          output_tokens: row.outputTokens ?? null,
        })
        .execute();
      return;
    }

    const db = getDbInstance();
    ensureCompressionRunTelemetryTable();
    db.prepare(
      `INSERT INTO compression_run_telemetry (
        timestamp, request_id, model, provider, source,
        tokens_before, tokens_after, ratio, cost_delta,
        output_styles, output_style_bypass, output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      row.requestId ?? null,
      row.model ?? null,
      row.provider ?? null,
      row.source ?? null,
      row.tokensBefore,
      row.tokensAfter,
      row.ratio,
      row.costDelta ?? null,
      row.outputStyles && row.outputStyles.length > 0 ? JSON.stringify(row.outputStyles) : null,
      row.outputStyleBypass ?? null,
      row.outputTokens ?? null
    );
  } catch {
    // best-effort telemetry — a write failure never affects a request
  }
}

export async function getCompressionRunTelemetrySummary(): Promise<CompressionRunTelemetrySummary> {
  let rows: Array<{
    tokens_before: number;
    tokens_after: number;
    output_styles: string | null;
    output_style_bypass: string | null;
    output_tokens: number | null;
  }>;

  if (isPostgres()) {
    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const pgRows = await kdb
      .selectFrom("compression_run_telemetry")
      .select([
        "tokens_before",
        "tokens_after",
        "output_styles",
        "output_style_bypass",
        "output_tokens",
      ])
      .execute();
    rows = pgRows.map((r) => ({
      tokens_before: toNum(r.tokens_before),
      tokens_after: toNum(r.tokens_after),
      output_styles: r.output_styles,
      output_style_bypass: r.output_style_bypass,
      output_tokens: r.output_tokens === null ? null : toNum(r.output_tokens),
    }));
  } else {
    const db = getDbInstance();
    ensureCompressionRunTelemetryTable();
    rows = db
      .prepare(
        `SELECT tokens_before, tokens_after, output_styles, output_style_bypass, output_tokens
         FROM compression_run_telemetry`
      )
      .all() as Array<{
      tokens_before: number;
      tokens_after: number;
      output_styles: string | null;
      output_style_bypass: string | null;
      output_tokens: number | null;
    }>;
  }

  const summary: CompressionRunTelemetrySummary = {
    totalRuns: rows.length,
    totalTokensSaved: 0,
    runsWithStyles: 0,
    bypassCount: 0,
    totalOutputTokens: 0,
    appliedStyleCounts: {},
  };

  for (const row of rows) {
    summary.totalTokensSaved += Math.max(0, row.tokens_before - row.tokens_after);
    summary.totalOutputTokens += row.output_tokens ?? 0;
    if (row.output_style_bypass) summary.bypassCount += 1;
    if (row.output_styles) {
      summary.runsWithStyles += 1;
      try {
        const styles = JSON.parse(row.output_styles) as Array<{ id: string }>;
        for (const style of styles) {
          summary.appliedStyleCounts[style.id] = (summary.appliedStyleCounts[style.id] ?? 0) + 1;
        }
      } catch {
        // ignore a corrupt JSON cell
      }
    }
  }
  return summary;
}
