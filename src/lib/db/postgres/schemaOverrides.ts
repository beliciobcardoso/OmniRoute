/**
 * Hand-maintained inputs for scripts/db/gen-postgres-schema.ts. Everything the
 * generator cannot infer from the fully-migrated SQLite schema lives here, so
 * every Postgres-specific decision is explicit and reviewed. The generator
 * fails on any SQLite construct it cannot translate and that is not listed
 * here — it never guesses.
 */

/**
 * SQLite has no boolean type: these INTEGER 0/1 columns become native
 * Postgres BOOLEAN (and `boolean` in the generated Kysely types). Only list a
 * column after reading its real reads/writes — a name alone (`priority`,
 * `backoff_level`) does not prove boolean intent. Postgres repositories must
 * map them back to the domain shape the SQLite repositories return.
 */
export const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set([
  "api_keys.allow_usage_command",
  "api_keys.auto_resolve",
  "api_keys.chaos_mode_enabled",
  "api_keys.disable_non_public_models",
  "api_keys.is_active",
  "api_keys.is_banned",
  "api_keys.no_log",
  "api_keys.usage_limit_enabled",
  "combos.context_cache_protection",
  "inspector_custom_hosts.enabled",
  "model_combo_mappings.enabled",
  "provider_connections.is_active",
  "provider_connections.per_key_proxy_enabled",
  "provider_connections.proxy_enabled",
  "provider_connections.rate_limit_protection",
]);

/**
 * Tables that exist only because of SQLite-specific features and have no
 * relational Postgres equivalent. FTS5 virtual tables and their shadow tables
 * are detected automatically; list anything else here with the reason.
 * Memory search in Postgres mode uses tsvector + Qdrant (POSTGRES_SUPPORT.md).
 */
export const SQLITE_ONLY_TABLES: ReadonlyMap<string, string> = new Map([
  ["memory_vec_meta", "sqlite-vec bookkeeping; Postgres mode requires Qdrant"],
]);

/**
 * Indexes whose SQLite definition uses an expression or a partial-index
 * predicate the generator cannot translate verbatim. Map the index name to
 * the exact Postgres DDL, or to `null` to omit it (state why in a comment).
 */
export const INDEX_OVERRIDES: ReadonlyMap<string, string | null> = new Map([
  [
    // COALESCE() key expressions are valid Postgres index expressions as-is.
    "idx_uh_dedup",
    "CREATE INDEX IF NOT EXISTS idx_uh_dedup ON usage_history (timestamp, COALESCE(provider, ''), " +
      "COALESCE(model, ''), COALESCE(connection_id, ''), COALESCE(api_key_id, ''), tokens_input, " +
      "tokens_output);",
  ],
]);
