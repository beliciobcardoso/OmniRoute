import type { ColumnType, Generated } from "kysely";

/**
 * Dual-dialect (SQLite + Postgres) schema for the Kysely layer used by the
 * opt-in PostgreSQL backend (see docs/architecture/POSTGRES_SUPPORT.md and
 * _tasks/superpowers/plans/2026-08-19-postgres-adapter.md, Fase 2/5).
 *
 * The interfaces below were generated from a real, fully-migrated SQLite
 * instance (getDbInstance() + PRAGMA table_info against every table), not
 * hand-transcribed from migration files — core.ts::SCHEMA_SQL and the 122
 * migrations under src/lib/db/migrations/ diverge in places (e.g. migration
 * 001_initial_schema.sql's api_keys is missing columns that SCHEMA_SQL
 * defines and 001 never actually runs against — it's auto-seeded as already
 * applied), so introspecting the real running schema is the only reliable
 * source of truth. Regenerate the same way if the schema changes materially.
 *
 * Excludes the FTS5/sqlite-vec shadow tables (memory_fts*, memory_vec_meta)
 * — those are handled separately under Fase 6 (tsvector + mandatory Qdrant
 * in Postgres mode), not modeled as plain relational tables here.
 *
 * Booleans: SQLite has no native boolean type — columns like `api_keys.no_log`
 * are declared `INTEGER NOT NULL DEFAULT 0` and store 0/1. Postgres uses a
 * real `boolean` column for the same field. `SqliteBoolean` models the
 * SQLite on-disk representation while still letting callers write/compare
 * `true`/`false`. Only columns with CONFIRMED boolean semantics (read from
 * their actual usage in the domain modules) are typed this way below — most
 * INTEGER columns here are left as `number` since a name alone
 * (`priority`, `backoff_level`, etc.) doesn't prove boolean-vs-count intent.
 * Re-type more columns as SqliteBoolean as each table is actually converted
 * (Fase 5) and its real usage is reviewed — do not bulk-guess.
 */
export type SqliteBoolean = ColumnType<boolean, 0 | 1 | boolean, 0 | 1 | boolean>;

// AUTO-GENERATED draft from a real, fully-migrated SQLite instance (PRAGMA table_info),
// captured 2026-08-19 — see _tasks/superpowers/plans/2026-08-19-postgres-adapter.md Fase 2.
// This is ground truth for column names/SQL types/nullability/defaults, mechanically
// mapped to TS (INTEGER/REAL -> number, TEXT -> string, BLOB -> Buffer). Booleans stored as
// SQLite INTEGER 0/1 are NOT auto-detected — re-type as SqliteBoolean per-column only when
// that table is actually converted (Fase 5) and its real read/write usage is reviewed.
// Excludes FTS5/sqlite-vec shadow tables (memory_fts*, memory_vec_meta) — handled in Fase 6.

export interface OmnirouteMigrationsTable {
  version: string;
  name: string;
  applied_at: Generated<string>;
}

export interface A2aTaskEventsTable {
  id: Generated<number>;
  task_id: string;
  event_type: string;
  data_json: string | null;
  created_at: Generated<string | null>;
}

export interface A2aTasksTable {
  id: string;
  state: Generated<string>;
  skill_id: string | null;
  input_json: string | null;
  output_json: string | null;
  cost_estimated: number | null;
  cost_actual: number | null;
  routing_explanation: string | null;
  resilience_trace: string | null;
  policy_verdict: string | null;
  api_key_id: string | null;
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
  completed_at: string | null;
  expires_at: string | null;
}

export interface AccountKeyLimitsTable {
  account_id: string;
  max_active_keys: number | null;
  daily_issue_limit: number | null;
  hourly_issue_limit: number | null;
  daily_issued: Generated<number>;
  hourly_issued: Generated<number>;
  last_reset_day: Generated<string>;
  last_reset_hour: Generated<string>;
  updated_at: Generated<string>;
}

export interface AgentBridgeBypassTable {
  pattern: string;
  source: string;
  created_at: Generated<string>;
}

export interface AgentBridgeMappingsTable {
  agent_id: string;
  source_model: string;
  target_model: string;
  updated_at: Generated<string>;
}

export interface AgentBridgeStateTable {
  agent_id: string;
  dns_enabled: Generated<number>;
  cert_trusted: Generated<number>;
  setup_completed: Generated<number>;
  last_started_at: string | null;
  last_error: string | null;
}

export interface ApiKeyContextSourcesTable {
  api_key_id: string;
  source_type: string;
  token: string | null;
  base_url: string | null;
  vault_path: string | null;
  enabled: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ApiKeyTokenCountersTable {
  limit_id: string;
  window_start: string;
  tokens_used: Generated<number>;
  updated_at: Generated<string>;
}

export interface ApiKeyTokenLimitResetLogsTable {
  id: Generated<number>;
  limit_id: string;
  reset_at: Generated<string>;
  prev_tokens: Generated<number>;
  window_start: string;
}

export interface ApiKeyTokenLimitsTable {
  id: string;
  api_key_id: string;
  scope_type: string;
  scope_value: Generated<string>;
  token_limit: number;
  reset_interval: Generated<string>;
  reset_time: string | null;
  enabled: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ApiKeysTable {
  id: string;
  name: string;
  key: string;
  machine_id: string | null;
  allowed_models: Generated<string | null>;
  no_log: Generated<SqliteBoolean>;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  key_prefix: string | null;
  ip_allowlist: string | null;
  scopes: string | null;
  allowed_combos: string | null;
  throttle_delay_ms: number | null;
  stream_default_mode: Generated<string>;
  allowed_quotas: Generated<string>;
  disable_non_public_models: Generated<SqliteBoolean>;
  usage_limit_enabled: Generated<SqliteBoolean>;
  daily_usage_limit_usd: number | null;
  weekly_usage_limit_usd: number | null;
}

export interface BadgeDefinitionsTable {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  rarity: Generated<string>;
  criteria: string | null;
  hidden: Generated<number>;
  created_at: Generated<string>;
}

export interface BatchItemCheckpointsTable {
  batch_id: string;
  line_number: Generated<number>;
  custom_id: string | null;
  status: string;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface BatchesTable {
  id: string;
  endpoint: string;
  completion_window: string;
  status: string;
  input_file_id: string;
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  in_progress_at: number | null;
  expires_at: number | null;
  finalizing_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  expired_at: number | null;
  cancelling_at: number | null;
  cancelled_at: number | null;
  request_counts_total: Generated<number | null>;
  request_counts_completed: Generated<number | null>;
  request_counts_failed: Generated<number | null>;
  metadata: string | null;
  api_key_id: string | null;
  errors: string | null;
  model: string | null;
  usage: string | null;
  output_expires_after_seconds: number | null;
  output_expires_after_anchor: string | null;
}

export interface CallLogsTable {
  id: string;
  timestamp: string;
  method: string | null;
  path: string | null;
  status: number | null;
  model: string | null;
  requested_model: string | null;
  provider: string | null;
  account: string | null;
  connection_id: string | null;
  duration: Generated<number | null>;
  tokens_in: Generated<number | null>;
  tokens_out: Generated<number | null>;
  tokens_cache_read: Generated<number | null>;
  tokens_cache_creation: Generated<number | null>;
  tokens_reasoning: Generated<number | null>;
  tokens_compressed: Generated<number | null>;
  cache_source: Generated<string | null>;
  request_type: string | null;
  source_format: string | null;
  target_format: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  combo_name: string | null;
  combo_step_id: string | null;
  combo_execution_key: string | null;
  error_summary: string | null;
  detail_state: Generated<string | null>;
  artifact_relpath: string | null;
  artifact_size_bytes: Generated<number | null>;
  artifact_sha256: Generated<string | null>;
  has_request_body: Generated<number | null>;
  has_response_body: Generated<number | null>;
  has_pipeline_details: Generated<number | null>;
  request_summary: string | null;
  correlation_id: string | null;
  model_pinned: Generated<number | null>;
  reasoning_source: Generated<string | null>;
  reasoning_chars: Generated<number | null>;
}

export interface CliAccessTokensTable {
  id: string;
  token_hash: string;
  token_prefix: string;
  name: string;
  scope: Generated<string>;
  created_at: Generated<string>;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CloudAgentCredentialsTable {
  provider_id: string;
  api_key_encrypted: string;
  base_url: string | null;
  updated_at: Generated<string>;
}

export interface ComboAdaptationStateTable {
  id: Generated<number>;
  combo_id: string;
  provider_id: string;
  learned_score: Generated<number | null>;
  request_count: Generated<number | null>;
  success_count: Generated<number | null>;
  avg_latency_ms: number | null;
  last_failure_at: string | null;
  excluded_until: string | null;
  updated_at: Generated<string | null>;
}

export interface CombosTable {
  id: string;
  name: string;
  data: string;
  sort_order: Generated<number>;
  created_at: string;
  updated_at: string;
  system_message: Generated<string | null>;
  tool_filter_regex: Generated<string | null>;
  context_cache_protection: Generated<SqliteBoolean | null>;
}

export interface CommandCodeAuthSessionsTable {
  id: string;
  state_hash: string;
  status: Generated<string>;
  encrypted_api_key: string | null;
  metadata_json: string | null;
  created_at: string;
  expires_at: string;
  received_at: string | null;
  applied_at: string | null;
  updated_at: string;
}

export interface CommunityServersTable {
  id: string;
  name: string;
  url: string;
  api_key_hash: string;
  connected_at: Generated<string>;
  last_sync_at: string | null;
  status: Generated<string>;
  error_message: string | null;
}

export interface CompressionAnalyticsTable {
  id: Generated<number>;
  timestamp: string;
  combo_id: string | null;
  provider: string | null;
  mode: string;
  original_tokens: number;
  compressed_tokens: number;
  tokens_saved: number;
  duration_ms: number | null;
  request_id: string | null;
  actual_prompt_tokens: number | null;
  actual_completion_tokens: number | null;
  actual_total_tokens: number | null;
  actual_cache_read_tokens: number | null;
  actual_cache_write_tokens: number | null;
  estimated_usd_saved: number | null;
  mcp_description_tokens_saved: Generated<number | null>;
  multimodal_skip_count: Generated<number | null>;
  receipt_source: string | null;
  validation_fallback: Generated<number | null>;
  output_mode: string | null;
  compression_combo_id: string | null;
  engine: string | null;
}

export interface CompressionCacheStatsTable {
  id: Generated<number>;
  provider: string;
  model: Generated<string>;
  compression_mode: string;
  cache_control_present: Generated<number>;
  estimated_cache_hit: Generated<number>;
  tokens_saved_compression: Generated<number>;
  tokens_saved_caching: Generated<number>;
  net_savings: Generated<number>;
  created_at: Generated<string | null>;
}

export interface CompressionComboAssignmentsTable {
  id: string;
  compression_combo_id: string;
  routing_combo_id: string;
  created_at: Generated<string | null>;
}

export interface CompressionCombosTable {
  id: string;
  name: string;
  description: Generated<string | null>;
  pipeline: Generated<string>;
  language_packs: Generated<string | null>;
  output_mode: Generated<number | null>;
  output_mode_intensity: Generated<string | null>;
  is_default: Generated<number | null>;
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
}

export interface ContextHandoffsTable {
  id: Generated<string>;
  session_id: string;
  combo_name: string;
  from_account: string;
  summary: string;
  key_decisions: Generated<string>;
  task_progress: Generated<string>;
  active_entities: Generated<string>;
  message_count: Generated<number>;
  model: Generated<string>;
  warning_threshold_pct: Generated<number>;
  generated_at: string;
  expires_at: string;
  created_at: Generated<string>;
  last_model: string | null;
}

export interface DailyUsageSummaryTable {
  id: Generated<number>;
  provider: string;
  model: string;
  date: string;
  total_requests: Generated<number>;
  total_input_tokens: Generated<number>;
  total_output_tokens: Generated<number>;
  total_cost: Generated<number>;
  created_at: Generated<string>;
}

export interface DbMetaTable {
  key: string;
  value: string | null;
}

export interface DiscoveryResultsTable {
  id: Generated<number>;
  provider_id: string;
  method: string;
  endpoint: string | null;
  auth_type: string | null;
  models: string | null;
  rate_limit: string | null;
  feasibility: number | null;
  risk_level: string | null;
  status: Generated<string | null>;
  notes: string | null;
  discovered_at: Generated<string | null>;
  verified_at: string | null;
}

export interface DomainBudgetResetLogsTable {
  id: Generated<number>;
  api_key_id: string;
  reset_interval: string;
  previous_spend: Generated<number>;
  reset_at: number;
  next_reset_at: number;
  period_start: number;
  period_end: number;
}

export interface DomainBudgetsTable {
  api_key_id: string;
  daily_limit_usd: number;
  weekly_limit_usd: Generated<number | null>;
  monthly_limit_usd: Generated<number | null>;
  warning_threshold: Generated<number | null>;
  reset_interval: Generated<string | null>;
  reset_time: Generated<string | null>;
  budget_reset_at: number | null;
  last_budget_reset_at: number | null;
  warning_emitted_at: number | null;
  warning_period_start: number | null;
}

export interface DomainCircuitBreakersTable {
  name: string;
  state: Generated<string>;
  failure_count: Generated<number | null>;
  last_failure_time: number | null;
  options: string | null;
}

export interface DomainCostHistoryTable {
  id: Generated<number>;
  api_key_id: string;
  cost: number;
  timestamp: number;
}

export interface DomainFallbackChainsTable {
  model: string;
  chain: string;
}

export interface DomainLockoutStateTable {
  identifier: string;
  attempts: string;
  locked_until: number | null;
}

export interface EvalCasesTable {
  id: string;
  suite_id: string;
  sort_order: Generated<number>;
  name: string;
  model: string | null;
  input_json: string;
  expected_strategy: string;
  expected_value: string | null;
  tags_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvalRunsTable {
  id: string;
  run_group_id: string | null;
  suite_id: string;
  suite_name: string;
  target_type: string;
  target_id: string | null;
  target_label: string;
  api_key_id: string | null;
  pass_rate: Generated<number>;
  total: Generated<number>;
  passed: Generated<number>;
  failed: Generated<number>;
  avg_latency_ms: Generated<number>;
  summary_json: string;
  results_json: string;
  outputs_json: string | null;
  created_at: string;
}

export interface EvalSuitesTable {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface FilesTable {
  id: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  content: Buffer | null;
  mime_type: string | null;
  api_key_id: string | null;
  deleted_at: number | null;
  expires_at: number | null;
}

export interface FreeProxiesTable {
  id: string;
  source: string;
  host: string;
  port: number;
  type: Generated<string>;
  country_code: string | null;
  quality_score: number | null;
  latency_ms: number | null;
  anonymity: string | null;
  last_validated: string | null;
  in_pool: Generated<number | null>;
  pool_proxy_id: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface FreeProxySyncErrorsTable {
  source: string;
  errors: string;
  updated_at: Generated<string>;
}

export interface GroupModelPermissionsTable {
  id: string;
  group_id: string;
  model_pattern: string;
  provider: string | null;
  access_type: Generated<string>;
  created_at: Generated<string>;
}

export interface HourlyUsageSummaryTable {
  id: Generated<number>;
  provider: string;
  model: string;
  date_hour: string;
  total_requests: Generated<number>;
  total_input_tokens: Generated<number>;
  total_output_tokens: Generated<number>;
  total_cost: Generated<number>;
  created_at: Generated<string>;
}

export interface InspectorCustomHostsTable {
  host: string;
  enabled: Generated<SqliteBoolean>;
  label: string | null;
  kind: Generated<string>;
  added_at: Generated<string>;
  last_seen_at: string | null;
}

export interface InspectorSessionRequestsTable {
  session_id: string;
  seq: Generated<number>;
  payload: string;
}

export interface InspectorSessionsTable {
  id: string;
  name: string | null;
  started_at: string;
  ended_at: string | null;
  request_count: Generated<number>;
  profile: string | null;
}

export interface InviteTokensTable {
  id: string;
  code: string;
  token_hash: string;
  created_by: string;
  used_by: string | null;
  server_url: string | null;
  max_uses: Generated<number>;
  use_count: Generated<number>;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: Generated<string>;
}

export interface KeyGroupMembersTable {
  key_id: string;
  group_id: string;
  created_at: Generated<string>;
}

export interface KeyGroupsTable {
  id: string;
  name: string;
  description: Generated<string>;
  is_active: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface KeyValueTable {
  namespace: string;
  key: string;
  value: string;
}

export interface LeaderboardTable {
  api_key_id: string;
  scope: Generated<string>;
  score: Generated<number>;
  updated_at: Generated<string>;
}

export interface McpToolAuditTable {
  id: Generated<number>;
  tool_name: string;
  input_hash: string | null;
  output_summary: string | null;
  duration_ms: number | null;
  api_key_id: string | null;
  success: Generated<number | null>;
  error_code: string | null;
  created_at: Generated<string | null>;
}

export interface MemoriesTable {
  id: string;
  api_key_id: string;
  session_id: string | null;
  type: string;
  key: string | null;
  content: string;
  metadata: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  expires_at: string | null;
  memory_id: number | null;
  needs_reindex: Generated<number>;
  access_count: Generated<number>;
  last_accessed_at: string | null;
}

export interface MiddlewareHooksTable {
  name: string;
  description: Generated<string>;
  priority: Generated<number>;
  scope_type: Generated<string>;
  combo_id: string | null;
  enabled: Generated<number>;
  code: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  run_count: Generated<number>;
  last_error: string | null;
}

export interface MiddlewareLogsTable {
  id: string;
  hook_name: string;
  request_id: string;
  duration_ms: Generated<number>;
  mutated: Generated<number>;
  skipped: Generated<number>;
  error: string | null;
  timestamp: Generated<string>;
}

export interface ModelCapabilityOverridesTable {
  provider: string;
  model_id: string;
  override_key: string;
  override_value: string;
  refreshed_at: Generated<string>;
}

export interface ModelComboMappingsTable {
  id: string;
  pattern: string;
  combo_id: string;
  priority: Generated<number | null>;
  enabled: Generated<number | null>;
  description: Generated<string | null>;
  created_at: string;
  updated_at: string;
}

export interface ModelContextOverridesTable {
  provider: string;
  model_id: string;
  real_context: number;
  source: Generated<string>;
  refreshed_at: Generated<string>;
}

export interface ModelIntelligenceTable {
  model: string;
  source: string;
  category: string;
  score: number;
  elo_raw: number | null;
  confidence: string | null;
  synced_at: Generated<string>;
  expires_at: string | null;
}

export interface PlaygroundPresetsTable {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  system: string | null;
  params_json: Generated<string>;
  created_at: Generated<string>;
}

export interface PluginAnalyticsTable {
  id: Generated<number>;
  plugin_name: string;
  hook: string;
  duration_ms: Generated<number>;
  success: Generated<number>;
  error_message: string | null;
  created_at: Generated<string>;
}

export interface PluginMetricsTable {
  plugin_name: string;
  event: string;
  calls: Generated<number>;
  errors: Generated<number>;
  total_duration_ms: Generated<number>;
  last_called_at: string | null;
}

export interface PluginsTable {
  id: string;
  name: string;
  version: Generated<string>;
  description: string | null;
  author: string | null;
  license: Generated<string | null>;
  main: Generated<string>;
  source: Generated<string>;
  tags: Generated<string | null>;
  status: Generated<string>;
  enabled: Generated<number>;
  manifest: string;
  config: Generated<string | null>;
  config_schema: Generated<string | null>;
  hooks: Generated<string | null>;
  permissions: Generated<string | null>;
  plugin_dir: string;
  error_message: string | null;
  installed_at: Generated<string>;
  updated_at: Generated<string>;
  activated_at: string | null;
}

export interface ProviderConnectionsTable {
  id: string;
  provider: string;
  auth_type: string | null;
  name: string | null;
  email: string | null;
  priority: Generated<number | null>;
  is_active: Generated<SqliteBoolean | null>;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  token_expires_at: string | null;
  scope: string | null;
  project_id: string | null;
  test_status: string | null;
  error_code: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_error_type: string | null;
  last_error_source: string | null;
  backoff_level: Generated<number | null>;
  rate_limited_until: string | null;
  health_check_interval: number | null;
  last_health_check_at: string | null;
  last_tested: string | null;
  api_key: string | null;
  id_token: string | null;
  provider_specific_data: string | null;
  expires_in: number | null;
  display_name: string | null;
  global_priority: number | null;
  default_model: string | null;
  token_type: string | null;
  consecutive_use_count: Generated<number | null>;
  rate_limit_protection: Generated<SqliteBoolean | null>;
  last_used_at: string | null;
  group: string | null;
  max_concurrent: number | null;
  proxy_enabled: Generated<SqliteBoolean>;
  per_key_proxy_enabled: Generated<SqliteBoolean>;
  quota_window_thresholds_json: string | null;
  rate_limit_overrides_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderKeyLimitsTable {
  provider: string;
  max_active_keys: number | null;
  daily_issue_limit: number | null;
  hourly_issue_limit: number | null;
  daily_issued: Generated<number>;
  hourly_issued: Generated<number>;
  last_reset_day: Generated<string>;
  last_reset_hour: Generated<string>;
  updated_at: Generated<string>;
}

export interface ProviderNodesTable {
  id: string;
  type: string;
  name: string;
  prefix: string | null;
  api_type: string | null;
  base_url: string | null;
  chat_path: string | null;
  models_path: string | null;
  custom_headers_json: string | null;
  created_at: string;
  updated_at: string;
  icon_url: string | null;
}

export interface ProviderPlansTable {
  connection_id: string;
  provider: string;
  dimensions_json: string;
  source: Generated<string>;
  updated_at: Generated<string>;
}

export interface ProviderQuotaResetEventsTable {
  id: Generated<number>;
  provider: string;
  connection_id: string;
  window_key: string;
  window_started_at: string;
  window_resets_at: string;
  observed_at: string;
  previous_remaining_percentage: number | null;
  new_remaining_percentage: number | null;
  previous_used_percentage: number | null;
  new_used_percentage: number | null;
  raw_data: string | null;
  created_at: Generated<string>;
}

export interface ProxyAssignmentsTable {
  id: Generated<number>;
  proxy_id: string;
  scope: string;
  scope_id: string | null;
  position: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ProxyLogsTable {
  id: string;
  timestamp: string;
  status: string | null;
  proxy_type: string | null;
  proxy_host: string | null;
  proxy_port: number | null;
  level: string | null;
  level_id: string | null;
  provider: string | null;
  target_url: string | null;
  public_ip: string | null;
  latency_ms: Generated<number | null>;
  error: string | null;
  connection_id: string | null;
  combo_id: string | null;
  account: string | null;
  tls_fingerprint: Generated<number | null>;
}

export interface ProxyRegistryTable {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  region: string | null;
  notes: string | null;
  status: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  source: Generated<string>;
  quality_score: number | null;
  latency_ms: number | null;
  anonymity: string | null;
  google_access: Generated<number | null>;
  last_validated: string | null;
  country_code: string | null;
  family: Generated<string>;
}

export interface ProxyScopeRotationTable {
  scope: string;
  scope_id: string;
  strategy: Generated<string>;
  cursor: Generated<number>;
  sticky_window_minutes: Generated<number>;
  rotated_at: string | null;
  updated_at: Generated<string>;
}

export interface QuotaAllocationModelCapsTable {
  pool_id: string;
  api_key_id: string;
  model: string;
  cap_value: number;
  cap_unit: string;
}

export interface QuotaAllocationsTable {
  pool_id: string;
  api_key_id: string;
  weight: number;
  cap_value: number | null;
  cap_unit: string | null;
  policy: Generated<string>;
}

export interface QuotaConsumptionTable {
  api_key_id: string;
  dimension_key: string;
  bucket_index: Generated<number>;
  consumed: Generated<number>;
  updated_at: number;
}

export interface QuotaGroupsTable {
  id: string;
  name: string;
  created_at: Generated<string>;
}

export interface QuotaPoolConnectionsTable {
  pool_id: string;
  connection_id: string;
  created_at: Generated<string>;
}

export interface QuotaPoolsTable {
  id: string;
  connection_id: string;
  name: string;
  created_at: Generated<string>;
  group_id: string | null;
}

export interface QuotaSnapshotsTable {
  id: Generated<number>;
  provider: string;
  connection_id: string;
  window_key: string;
  remaining_percentage: number | null;
  is_exhausted: Generated<number | null>;
  next_reset_at: string | null;
  window_duration_ms: number | null;
  raw_data: string | null;
  created_at: Generated<string>;
}

export interface ReasoningCacheTable {
  tool_call_id: string;
  provider: string;
  model: string;
  reasoning: string;
  char_count: Generated<number>;
  created_at: Generated<string>;
  expires_at: number;
}

export interface RegisteredKeysTable {
  id: string;
  key: string;
  key_prefix: string;
  name: string;
  provider: Generated<string>;
  account_id: Generated<string>;
  is_active: Generated<number>;
  revoked_at: string | null;
  expires_at: string | null;
  idempotency_key: string | null;
  daily_budget: number | null;
  hourly_budget: number | null;
  daily_used: Generated<number>;
  hourly_used: Generated<number>;
  last_reset_day: Generated<string>;
  last_reset_hour: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface RelayLogsTable {
  id: Generated<number>;
  token_id: string;
  request_id: string | null;
  model: string | null;
  prompt_tokens: Generated<number | null>;
  completion_tokens: Generated<number | null>;
  cost: Generated<number | null>;
  status: Generated<string | null>;
  status_code: Generated<number | null>;
  latency_ms: Generated<number | null>;
  client_ip: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface RelayRateLimitsTable {
  token_id: string;
  window_start: Generated<number>;
  request_count: Generated<number | null>;
  cost: Generated<number | null>;
}

export interface RelayTokensTable {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  description: Generated<string | null>;
  combo_id: string | null;
  allowed_models: Generated<string | null>;
  max_tokens_per_request: Generated<number | null>;
  max_requests_per_minute: Generated<number | null>;
  max_requests_per_day: Generated<number | null>;
  max_cost_per_day: Generated<number | null>;
  enabled: Generated<number | null>;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  metadata: Generated<string | null>;
}

export interface RequestDetailLogsTable {
  id: string;
  call_log_id: string | null;
  timestamp: string;
  client_request: string | null;
  translated_request: string | null;
  provider_response: string | null;
  client_response: string | null;
  provider: string | null;
  model: string | null;
  source_format: string | null;
  target_format: string | null;
  duration_ms: Generated<number | null>;
}

export interface RoutingDecisionsTable {
  id: Generated<number>;
  request_id: string | null;
  task_type: string | null;
  combo_id: string | null;
  provider_selected: string | null;
  model_selected: string | null;
  score: number | null;
  factors_json: string | null;
  fallbacks_triggered: Generated<number | null>;
  success: Generated<number | null>;
  latency_ms: number | null;
  cost: number | null;
  source: Generated<string | null>;
  created_at: Generated<string | null>;
}

export interface SemanticCacheTable {
  id: string;
  signature: string;
  model: string;
  prompt_hash: string;
  response: string;
  tokens_saved: Generated<number | null>;
  hit_count: Generated<number | null>;
  created_at: string;
  expires_at: string;
}

export interface SessionAccountAffinityTable {
  session_key: string;
  provider: string;
  connection_id: string;
  created_at: number;
  last_seen_at: number;
}

export interface SessionModelHistoryTable {
  id: Generated<number>;
  session_id: string;
  combo_name: string;
  model_str: string;
  provider: string;
  connection_id: string | null;
  used_at: Generated<string>;
}

export interface SkillExecutionsTable {
  id: string;
  skill_id: string;
  api_key_id: string;
  session_id: string | null;
  input: string;
  output: string | null;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
  created_at: Generated<string>;
}

export interface SkillsTable {
  id: string;
  api_key_id: string;
  name: string;
  version: Generated<string>;
  description: string | null;
  schema: string;
  handler: string;
  enabled: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  mode: Generated<string>;
  source_provider: string | null;
  tags: string | null;
  install_count: Generated<number>;
}

export interface SyncTokensTable {
  id: string;
  name: string;
  token_hash: string;
  sync_api_key_id: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TierAssignmentsTable {
  provider: string;
  model: string;
  tier: string;
  cost_per_1m_input: Generated<number | null>;
  cost_per_1m_output: Generated<number | null>;
  has_free_tier: Generated<number | null>;
  free_quota_limit: number | null;
  reason: string | null;
  updated_at: Generated<string | null>;
}

export interface TierConfigTable {
  key: string;
  value: string;
  updated_at: Generated<string | null>;
}

export interface TokenLedgerTable {
  id: Generated<number>;
  from_api_key_id: string;
  to_api_key_id: string;
  amount: number;
  reason: string | null;
  idempotency_key: string | null;
  created_at: Generated<string>;
}

export interface UpstreamProxyConfigTable {
  id: Generated<number>;
  provider_id: string;
  mode: Generated<string>;
  cliproxyapi_model_mapping: string | null;
  native_priority: Generated<number>;
  cliproxyapi_priority: Generated<number>;
  enabled: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  family: Generated<string>;
}

export interface UsageHistoryTable {
  id: Generated<number>;
  provider: string | null;
  model: string | null;
  connection_id: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  tokens_input: Generated<number | null>;
  tokens_output: Generated<number | null>;
  tokens_cache_read: Generated<number | null>;
  tokens_cache_creation: Generated<number | null>;
  tokens_reasoning: Generated<number | null>;
  service_tier: Generated<string | null>;
  status: string | null;
  success: Generated<number | null>;
  latency_ms: Generated<number | null>;
  ttft_ms: Generated<number | null>;
  error_code: string | null;
  timestamp: string;
  combo_strategy: Generated<string | null>;
  endpoint: string | null;
}

export interface UserBadgesTable {
  api_key_id: string;
  badge_id: string;
  unlocked_at: Generated<string>;
}

export interface UserLevelsTable {
  api_key_id: string;
  total_xp: Generated<number>;
  current_level: Generated<number>;
  updated_at: Generated<string>;
}

export interface VersionManagerTable {
  id: Generated<number>;
  tool: string;
  current_version: string | null;
  installed_version: string | null;
  pinned_version: string | null;
  binary_path: string | null;
  status: Generated<string>;
  pid: number | null;
  port: Generated<number | null>;
  api_key: string | null;
  management_key: string | null;
  auto_update: Generated<number>;
  auto_start: Generated<number>;
  last_health_check: string | null;
  last_update_check: string | null;
  health_status: Generated<string | null>;
  config_overrides: string | null;
  error_message: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  logs_buffer_path: string | null;
  provider_expose: Generated<number>;
  last_sync_at: string | null;
}

export interface WebhookDeliveriesTable {
  id: Generated<number>;
  webhook_id: string;
  event_type: string;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  payload_snapshot: string | null;
  created_at: Generated<string>;
}

export interface WebhooksTable {
  id: string;
  url: string;
  events: Generated<string>;
  secret: string | null;
  enabled: Generated<number | null>;
  description: Generated<string | null>;
  created_at: Generated<string | null>;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: Generated<number | null>;
  kind: Generated<string>;
  metadata_encrypted: Buffer | null;
}

export interface XpAuditLogTable {
  id: Generated<number>;
  api_key_id: string;
  action: string;
  xp_earned: number;
  metadata: string | null;
  created_at: Generated<string>;
}

export interface Database {
  _omniroute_migrations: OmnirouteMigrationsTable;
  a2a_task_events: A2aTaskEventsTable;
  a2a_tasks: A2aTasksTable;
  account_key_limits: AccountKeyLimitsTable;
  agent_bridge_bypass: AgentBridgeBypassTable;
  agent_bridge_mappings: AgentBridgeMappingsTable;
  agent_bridge_state: AgentBridgeStateTable;
  api_key_context_sources: ApiKeyContextSourcesTable;
  api_key_token_counters: ApiKeyTokenCountersTable;
  api_key_token_limit_reset_logs: ApiKeyTokenLimitResetLogsTable;
  api_key_token_limits: ApiKeyTokenLimitsTable;
  api_keys: ApiKeysTable;
  badge_definitions: BadgeDefinitionsTable;
  batch_item_checkpoints: BatchItemCheckpointsTable;
  batches: BatchesTable;
  call_logs: CallLogsTable;
  cli_access_tokens: CliAccessTokensTable;
  cloud_agent_credentials: CloudAgentCredentialsTable;
  combo_adaptation_state: ComboAdaptationStateTable;
  combos: CombosTable;
  command_code_auth_sessions: CommandCodeAuthSessionsTable;
  community_servers: CommunityServersTable;
  compression_analytics: CompressionAnalyticsTable;
  compression_cache_stats: CompressionCacheStatsTable;
  compression_combo_assignments: CompressionComboAssignmentsTable;
  compression_combos: CompressionCombosTable;
  context_handoffs: ContextHandoffsTable;
  daily_usage_summary: DailyUsageSummaryTable;
  db_meta: DbMetaTable;
  discovery_results: DiscoveryResultsTable;
  domain_budget_reset_logs: DomainBudgetResetLogsTable;
  domain_budgets: DomainBudgetsTable;
  domain_circuit_breakers: DomainCircuitBreakersTable;
  domain_cost_history: DomainCostHistoryTable;
  domain_fallback_chains: DomainFallbackChainsTable;
  domain_lockout_state: DomainLockoutStateTable;
  eval_cases: EvalCasesTable;
  eval_runs: EvalRunsTable;
  eval_suites: EvalSuitesTable;
  files: FilesTable;
  free_proxies: FreeProxiesTable;
  free_proxy_sync_errors: FreeProxySyncErrorsTable;
  group_model_permissions: GroupModelPermissionsTable;
  hourly_usage_summary: HourlyUsageSummaryTable;
  inspector_custom_hosts: InspectorCustomHostsTable;
  inspector_session_requests: InspectorSessionRequestsTable;
  inspector_sessions: InspectorSessionsTable;
  invite_tokens: InviteTokensTable;
  key_group_members: KeyGroupMembersTable;
  key_groups: KeyGroupsTable;
  key_value: KeyValueTable;
  leaderboard: LeaderboardTable;
  mcp_tool_audit: McpToolAuditTable;
  memories: MemoriesTable;
  middleware_hooks: MiddlewareHooksTable;
  middleware_logs: MiddlewareLogsTable;
  model_capability_overrides: ModelCapabilityOverridesTable;
  model_combo_mappings: ModelComboMappingsTable;
  model_context_overrides: ModelContextOverridesTable;
  model_intelligence: ModelIntelligenceTable;
  playground_presets: PlaygroundPresetsTable;
  plugin_analytics: PluginAnalyticsTable;
  plugin_metrics: PluginMetricsTable;
  plugins: PluginsTable;
  provider_connections: ProviderConnectionsTable;
  provider_key_limits: ProviderKeyLimitsTable;
  provider_nodes: ProviderNodesTable;
  provider_plans: ProviderPlansTable;
  provider_quota_reset_events: ProviderQuotaResetEventsTable;
  proxy_assignments: ProxyAssignmentsTable;
  proxy_logs: ProxyLogsTable;
  proxy_registry: ProxyRegistryTable;
  proxy_scope_rotation: ProxyScopeRotationTable;
  quota_allocation_model_caps: QuotaAllocationModelCapsTable;
  quota_allocations: QuotaAllocationsTable;
  quota_consumption: QuotaConsumptionTable;
  quota_groups: QuotaGroupsTable;
  quota_pool_connections: QuotaPoolConnectionsTable;
  quota_pools: QuotaPoolsTable;
  quota_snapshots: QuotaSnapshotsTable;
  reasoning_cache: ReasoningCacheTable;
  registered_keys: RegisteredKeysTable;
  relay_logs: RelayLogsTable;
  relay_rate_limits: RelayRateLimitsTable;
  relay_tokens: RelayTokensTable;
  request_detail_logs: RequestDetailLogsTable;
  routing_decisions: RoutingDecisionsTable;
  semantic_cache: SemanticCacheTable;
  session_account_affinity: SessionAccountAffinityTable;
  session_model_history: SessionModelHistoryTable;
  skill_executions: SkillExecutionsTable;
  skills: SkillsTable;
  sync_tokens: SyncTokensTable;
  tier_assignments: TierAssignmentsTable;
  tier_config: TierConfigTable;
  token_ledger: TokenLedgerTable;
  upstream_proxy_config: UpstreamProxyConfigTable;
  usage_history: UsageHistoryTable;
  user_badges: UserBadgesTable;
  user_levels: UserLevelsTable;
  version_manager: VersionManagerTable;
  webhook_deliveries: WebhookDeliveriesTable;
  webhooks: WebhooksTable;
  xp_audit_log: XpAuditLogTable;
}
