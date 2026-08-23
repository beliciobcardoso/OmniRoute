-- AUTO-GENERATED Postgres bootstrap DDL for the opt-in Postgres backend.
-- Source: real, fully-migrated SQLite schema (PRAGMA table_info), captured 2026-08-19.
-- See docs/architecture/POSTGRES_SUPPORT.md and
-- _tasks/superpowers/plans/2026-08-19-postgres-adapter.md (Fase 4).
--
-- This is a single greenfield bootstrap, NOT a replay of the 119 SQLite migrations:
-- Postgres mode has no existing data/installs to migrate incrementally (confirmed with
-- the operator), so all 104 relational tables are created directly in final form.
-- FTS5/sqlite-vec shadow tables are intentionally excluded (Fase 6: tsvector + Qdrant).

CREATE TABLE IF NOT EXISTS _omniroute_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS a2a_task_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'submitted',
  skill_id TEXT,
  input_json TEXT,
  output_json TEXT,
  cost_estimated DOUBLE PRECISION,
  cost_actual DOUBLE PRECISION,
  routing_explanation TEXT,
  resilience_trace TEXT,
  policy_verdict TEXT,
  api_key_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS account_key_limits (
  account_id TEXT PRIMARY KEY,
  max_active_keys BIGINT,
  daily_issue_limit BIGINT,
  hourly_issue_limit BIGINT,
  daily_issued BIGINT NOT NULL DEFAULT 0,
  hourly_issued BIGINT NOT NULL DEFAULT 0,
  last_reset_day TEXT NOT NULL DEFAULT '',
  last_reset_hour TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_bridge_bypass (
  pattern TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_bridge_mappings (
  agent_id TEXT NOT NULL,
  source_model TEXT NOT NULL,
  target_model TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id, source_model)
);

CREATE TABLE IF NOT EXISTS agent_bridge_state (
  agent_id TEXT PRIMARY KEY,
  dns_enabled BIGINT NOT NULL DEFAULT 0,
  cert_trusted BIGINT NOT NULL DEFAULT 0,
  setup_completed BIGINT NOT NULL DEFAULT 0,
  last_started_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS api_key_context_sources (
  api_key_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  token TEXT,
  base_url TEXT,
  vault_path TEXT,
  enabled BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (api_key_id, source_type)
);

CREATE TABLE IF NOT EXISTS api_key_token_counters (
  limit_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (limit_id, window_start)
);

CREATE TABLE IF NOT EXISTS api_key_token_limit_reset_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  limit_id TEXT NOT NULL,
  reset_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  prev_tokens BIGINT NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_key_token_limits (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL DEFAULT '',
  token_limit BIGINT NOT NULL,
  reset_interval TEXT NOT NULL DEFAULT 'monthly',
  reset_time TEXT,
  enabled BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (api_key_id, scope_type, scope_value)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "key" TEXT NOT NULL,
  machine_id TEXT,
  allowed_models TEXT DEFAULT '[]',
  no_log BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  key_prefix TEXT,
  ip_allowlist TEXT,
  scopes TEXT,
  allowed_combos TEXT,
  throttle_delay_ms BIGINT,
  stream_default_mode TEXT NOT NULL DEFAULT 'legacy',
  allowed_quotas TEXT NOT NULL DEFAULT '[]',
  disable_non_public_models BOOLEAN NOT NULL DEFAULT FALSE,
  usage_limit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  daily_usage_limit_usd DOUBLE PRECISION,
  weekly_usage_limit_usd DOUBLE PRECISION,
  blocked_models TEXT,
  allowed_connections TEXT,
  auto_resolve BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  access_schedule TEXT,
  max_requests_per_day BIGINT,
  max_requests_per_minute BIGINT,
  max_sessions BIGINT NOT NULL DEFAULT 0,
  rate_limits TEXT,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  key_hash TEXT,
  proxy_id TEXT,
  allowed_endpoints TEXT,
  allow_usage_command BOOLEAN NOT NULL DEFAULT FALSE,
  chaos_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS badge_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  category TEXT,
  rarity TEXT NOT NULL DEFAULT 'common',
  criteria TEXT,
  hidden BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS batch_item_checkpoints (
  batch_id TEXT NOT NULL,
  line_number BIGINT NOT NULL,
  custom_id TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (batch_id, line_number)
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  completion_window TEXT NOT NULL,
  status TEXT NOT NULL,
  input_file_id TEXT NOT NULL,
  output_file_id TEXT,
  error_file_id TEXT,
  created_at BIGINT NOT NULL,
  in_progress_at BIGINT,
  expires_at BIGINT,
  finalizing_at BIGINT,
  completed_at BIGINT,
  failed_at BIGINT,
  expired_at BIGINT,
  cancelling_at BIGINT,
  cancelled_at BIGINT,
  request_counts_total BIGINT DEFAULT 0,
  request_counts_completed BIGINT DEFAULT 0,
  request_counts_failed BIGINT DEFAULT 0,
  metadata TEXT,
  api_key_id TEXT,
  errors TEXT,
  model TEXT,
  usage TEXT,
  output_expires_after_seconds BIGINT,
  output_expires_after_anchor TEXT
);

CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  method TEXT,
  path TEXT,
  status BIGINT,
  model TEXT,
  requested_model TEXT,
  provider TEXT,
  account TEXT,
  connection_id TEXT,
  duration BIGINT DEFAULT 0,
  tokens_in BIGINT DEFAULT 0,
  tokens_out BIGINT DEFAULT 0,
  tokens_cache_read BIGINT DEFAULT NULL,
  tokens_cache_creation BIGINT DEFAULT NULL,
  tokens_reasoning BIGINT DEFAULT NULL,
  tokens_compressed BIGINT DEFAULT NULL,
  cache_source TEXT DEFAULT '"upstream"',
  request_type TEXT,
  source_format TEXT,
  target_format TEXT,
  api_key_id TEXT,
  api_key_name TEXT,
  combo_name TEXT,
  combo_step_id TEXT,
  combo_execution_key TEXT,
  error_summary TEXT,
  detail_state TEXT DEFAULT 'none',
  artifact_relpath TEXT,
  artifact_size_bytes BIGINT DEFAULT NULL,
  artifact_sha256 TEXT DEFAULT NULL,
  has_request_body BIGINT DEFAULT 0,
  has_response_body BIGINT DEFAULT 0,
  has_pipeline_details BIGINT DEFAULT 0,
  request_summary TEXT,
  correlation_id TEXT,
  model_pinned BIGINT DEFAULT 0,
  reasoning_source TEXT DEFAULT NULL,
  reasoning_chars BIGINT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS cli_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS cloud_agent_credentials (
  provider_id TEXT PRIMARY KEY,
  api_key_encrypted TEXT NOT NULL,
  base_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS combo_adaptation_state (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  combo_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  learned_score DOUBLE PRECISION DEFAULT 0.5,
  request_count BIGINT DEFAULT 0,
  success_count BIGINT DEFAULT 0,
  avg_latency_ms DOUBLE PRECISION,
  last_failure_at TEXT,
  excluded_until TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  sort_order BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  system_message TEXT DEFAULT NULL,
  tool_filter_regex TEXT DEFAULT NULL,
  context_cache_protection BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS command_code_auth_sessions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  encrypted_api_key TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  received_at TEXT,
  applied_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS compression_analytics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp TEXT NOT NULL,
  combo_id TEXT,
  provider TEXT,
  mode TEXT NOT NULL,
  original_tokens BIGINT NOT NULL,
  compressed_tokens BIGINT NOT NULL,
  tokens_saved BIGINT NOT NULL,
  duration_ms BIGINT,
  request_id TEXT,
  actual_prompt_tokens BIGINT,
  actual_completion_tokens BIGINT,
  actual_total_tokens BIGINT,
  actual_cache_read_tokens BIGINT,
  actual_cache_write_tokens BIGINT,
  estimated_usd_saved DOUBLE PRECISION,
  mcp_description_tokens_saved BIGINT DEFAULT 0,
  multimodal_skip_count BIGINT DEFAULT 0,
  receipt_source TEXT,
  validation_fallback BIGINT DEFAULT 0,
  output_mode TEXT,
  compression_combo_id TEXT,
  engine TEXT,
  rtk_raw_output_pointer TEXT,
  rtk_raw_output_bytes BIGINT,
  rtk_raw_output_pointers TEXT,
  rtk_raw_output_total_bytes BIGINT,
  skip_reason TEXT
);

CREATE TABLE IF NOT EXISTS compression_engine_breakdown (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp TEXT NOT NULL,
  request_id TEXT,
  engine TEXT NOT NULL,
  original_tokens BIGINT NOT NULL DEFAULT 0,
  compressed_tokens BIGINT NOT NULL DEFAULT 0,
  tokens_saved BIGINT NOT NULL DEFAULT 0,
  duration_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ceb_engine_ts ON compression_engine_breakdown(engine, timestamp);
CREATE INDEX IF NOT EXISTS idx_ceb_request ON compression_engine_breakdown(request_id);

CREATE TABLE IF NOT EXISTS compression_cache_stats (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  compression_mode TEXT NOT NULL,
  cache_control_present BIGINT NOT NULL DEFAULT 0,
  estimated_cache_hit BIGINT NOT NULL DEFAULT 0,
  tokens_saved_compression BIGINT NOT NULL DEFAULT 0,
  tokens_saved_caching BIGINT NOT NULL DEFAULT 0,
  net_savings BIGINT NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compression_run_telemetry (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "timestamp" BIGINT NOT NULL,
  request_id TEXT,
  model TEXT,
  provider TEXT,
  source TEXT,
  tokens_before BIGINT NOT NULL,
  tokens_after BIGINT NOT NULL,
  ratio DOUBLE PRECISION,
  cost_delta DOUBLE PRECISION,
  output_styles TEXT,
  output_style_bypass TEXT,
  output_tokens BIGINT
);

CREATE TABLE IF NOT EXISTS compression_combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  pipeline TEXT NOT NULL DEFAULT '[]',
  language_packs TEXT DEFAULT '["en"]',
  output_mode BIGINT DEFAULT 0,
  output_mode_intensity TEXT DEFAULT 'full',
  is_default BIGINT DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compression_combo_assignments (
  id TEXT PRIMARY KEY,
  compression_combo_id TEXT NOT NULL REFERENCES compression_combos(id) ON DELETE CASCADE,
  routing_combo_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(routing_combo_id)
);

CREATE INDEX IF NOT EXISTS idx_compression_combos_default
  ON compression_combos(is_default);
CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_combo
  ON compression_combo_assignments(compression_combo_id);
CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_routing
  ON compression_combo_assignments(routing_combo_id);

CREATE TABLE IF NOT EXISTS context_handoffs (
  id TEXT PRIMARY KEY DEFAULT (substr(md5(random()::text || clock_timestamp()::text), 1, 16)),
  session_id TEXT NOT NULL,
  combo_name TEXT NOT NULL,
  from_account TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_decisions TEXT NOT NULL DEFAULT '[]',
  task_progress TEXT NOT NULL DEFAULT '',
  active_entities TEXT NOT NULL DEFAULT '[]',
  message_count BIGINT NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  warning_threshold_pct DOUBLE PRECISION NOT NULL DEFAULT 0.85,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  last_model TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_handoffs_session_combo
  ON context_handoffs(session_id, combo_name);

CREATE TABLE IF NOT EXISTS daily_usage_summary (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  date TEXT NOT NULL,
  total_requests BIGINT NOT NULL DEFAULT 0,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_usage_unique
  ON daily_usage_summary(provider, model, date);

CREATE TABLE IF NOT EXISTS db_meta (
  "key" TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS discovery_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id TEXT NOT NULL,
  method TEXT NOT NULL,
  endpoint TEXT,
  auth_type TEXT,
  models TEXT,
  rate_limit TEXT,
  feasibility BIGINT,
  risk_level TEXT,
  status TEXT DEFAULT 'pending',
  notes TEXT,
  discovered_at TEXT DEFAULT CURRENT_TIMESTAMP,
  verified_at TEXT,
  UNIQUE (provider_id, method, endpoint)
);

CREATE TABLE IF NOT EXISTS domain_budget_reset_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  reset_interval TEXT NOT NULL,
  previous_spend DOUBLE PRECISION NOT NULL DEFAULT 0,
  reset_at BIGINT NOT NULL,
  next_reset_at BIGINT NOT NULL,
  period_start BIGINT NOT NULL,
  period_end BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_budgets (
  api_key_id TEXT PRIMARY KEY,
  daily_limit_usd DOUBLE PRECISION NOT NULL,
  weekly_limit_usd DOUBLE PRECISION DEFAULT 0,
  monthly_limit_usd DOUBLE PRECISION DEFAULT 0,
  warning_threshold DOUBLE PRECISION DEFAULT 0.8,
  reset_interval TEXT DEFAULT 'daily',
  reset_time TEXT DEFAULT '00:00',
  budget_reset_at BIGINT,
  last_budget_reset_at BIGINT,
  warning_emitted_at BIGINT,
  warning_period_start BIGINT
);

CREATE TABLE IF NOT EXISTS domain_circuit_breakers (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'CLOSED',
  failure_count BIGINT DEFAULT 0,
  last_failure_time BIGINT,
  options TEXT
);

CREATE TABLE IF NOT EXISTS domain_cost_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  cost DOUBLE PRECISION NOT NULL,
  timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_fallback_chains (
  model TEXT PRIMARY KEY,
  chain TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_lockout_state (
  identifier TEXT PRIMARY KEY,
  attempts TEXT NOT NULL,
  locked_until BIGINT
);

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  sort_order BIGINT NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  model TEXT,
  input_json TEXT NOT NULL,
  expected_strategy TEXT NOT NULL,
  expected_value TEXT,
  tags_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  run_group_id TEXT,
  suite_id TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT NOT NULL,
  api_key_id TEXT,
  pass_rate BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  passed BIGINT NOT NULL DEFAULT 0,
  failed BIGINT NOT NULL DEFAULT 0,
  avg_latency_ms BIGINT NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  outputs_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_suites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  bytes BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  filename TEXT NOT NULL,
  purpose TEXT NOT NULL,
  content BYTEA,
  mime_type TEXT,
  api_key_id TEXT,
  deleted_at BIGINT,
  expires_at BIGINT
);

CREATE TABLE IF NOT EXISTS free_proxies (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  host TEXT NOT NULL,
  port BIGINT NOT NULL,
  type TEXT NOT NULL DEFAULT 'http',
  country_code TEXT,
  quality_score BIGINT,
  latency_ms BIGINT,
  anonymity TEXT,
  last_validated TEXT,
  in_pool BIGINT DEFAULT 0,
  pool_proxy_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS free_proxy_sync_errors (
  source TEXT PRIMARY KEY,
  errors TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS group_model_permissions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  model_pattern TEXT NOT NULL,
  provider TEXT,
  access_type TEXT NOT NULL DEFAULT 'allow',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hourly_usage_summary (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  date_hour TEXT NOT NULL,
  total_requests BIGINT NOT NULL DEFAULT 0,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hourly_usage_unique
  ON hourly_usage_summary(provider, model, date_hour);

CREATE TABLE IF NOT EXISTS inspector_custom_hosts (
  host TEXT PRIMARY KEY,
  enabled BIGINT NOT NULL DEFAULT 1,
  label TEXT,
  kind TEXT NOT NULL DEFAULT 'custom',
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS inspector_session_requests (
  session_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS inspector_sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  request_count BIGINT NOT NULL DEFAULT 0,
  profile TEXT
);

CREATE TABLE IF NOT EXISTS invite_tokens (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  used_by TEXT,
  server_url TEXT,
  max_uses BIGINT NOT NULL DEFAULT 1,
  use_count BIGINT NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS key_group_members (
  key_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_id, group_id)
);

CREATE TABLE IF NOT EXISTS key_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS key_value (
  namespace TEXT NOT NULL,
  "key" TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (namespace, "key")
);

CREATE TABLE IF NOT EXISTS leaderboard (
  api_key_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  score BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (api_key_id, scope)
);

CREATE TABLE IF NOT EXISTS mcp_tool_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input_hash TEXT,
  output_summary TEXT,
  duration_ms BIGINT,
  api_key_id TEXT,
  success BIGINT DEFAULT 1,
  error_code TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL,
  "key" TEXT,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  memory_id BIGINT,
  needs_reindex BIGINT NOT NULL DEFAULT 0,
  access_count BIGINT NOT NULL DEFAULT 0,
  last_accessed_at TEXT
);

CREATE TABLE IF NOT EXISTS middleware_hooks (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  priority BIGINT NOT NULL DEFAULT 200,
  scope_type TEXT NOT NULL DEFAULT 'global',
  combo_id TEXT,
  enabled BIGINT NOT NULL DEFAULT 1,
  code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  run_count BIGINT NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS middleware_logs (
  id TEXT PRIMARY KEY,
  hook_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  mutated BIGINT NOT NULL DEFAULT 0,
  skipped BIGINT NOT NULL DEFAULT 0,
  error TEXT,
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_capability_overrides (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  override_key TEXT NOT NULL,
  override_value TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, model_id, override_key)
);

CREATE TABLE IF NOT EXISTS model_combo_mappings (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  priority BIGINT DEFAULT 0,
  enabled BIGINT DEFAULT 1,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_context_overrides (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  real_context BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, model_id)
);

CREATE TABLE IF NOT EXISTS model_intelligence (
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  elo_raw BIGINT,
  confidence TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  PRIMARY KEY (model, source, category)
);

CREATE TABLE IF NOT EXISTS playground_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  system TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plugin_analytics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_name TEXT NOT NULL,
  hook TEXT NOT NULL,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  success BIGINT NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plugin_metrics (
  plugin_name TEXT NOT NULL,
  event TEXT NOT NULL,
  calls BIGINT NOT NULL DEFAULT 0,
  errors BIGINT NOT NULL DEFAULT 0,
  total_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_called_at TEXT,
  PRIMARY KEY (plugin_name, event)
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT,
  author TEXT,
  license TEXT DEFAULT 'MIT',
  main TEXT NOT NULL DEFAULT 'index.js',
  source TEXT NOT NULL DEFAULT 'local',
  tags TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'installed',
  enabled BIGINT NOT NULL DEFAULT 0,
  manifest TEXT NOT NULL,
  config TEXT DEFAULT '{}',
  config_schema TEXT DEFAULT '{}',
  hooks TEXT DEFAULT '[]',
  permissions TEXT DEFAULT '[]',
  plugin_dir TEXT NOT NULL,
  error_message TEXT,
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  auth_type TEXT,
  name TEXT,
  email TEXT,
  priority BIGINT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  token_expires_at TEXT,
  scope TEXT,
  project_id TEXT,
  test_status TEXT,
  error_code TEXT,
  last_error TEXT,
  last_error_at TEXT,
  last_error_type TEXT,
  last_error_source TEXT,
  backoff_level BIGINT DEFAULT 0,
  rate_limited_until TEXT,
  health_check_interval BIGINT,
  last_health_check_at TEXT,
  last_tested TEXT,
  api_key TEXT,
  id_token TEXT,
  provider_specific_data TEXT,
  expires_in BIGINT,
  display_name TEXT,
  global_priority BIGINT,
  default_model TEXT,
  token_type TEXT,
  consecutive_use_count BIGINT DEFAULT 0,
  rate_limit_protection BOOLEAN DEFAULT FALSE,
  last_used_at TEXT,
  "group" TEXT,
  max_concurrent BIGINT,
  proxy_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  per_key_proxy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  quota_window_thresholds_json TEXT,
  rate_limit_overrides_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_key_limits (
  provider TEXT PRIMARY KEY,
  max_active_keys BIGINT,
  daily_issue_limit BIGINT,
  hourly_issue_limit BIGINT,
  daily_issued BIGINT NOT NULL DEFAULT 0,
  hourly_issued BIGINT NOT NULL DEFAULT 0,
  last_reset_day TEXT NOT NULL DEFAULT '',
  last_reset_hour TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS provider_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT,
  api_type TEXT,
  base_url TEXT,
  chat_path TEXT,
  models_path TEXT,
  custom_headers_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  icon_url TEXT
);

CREATE TABLE IF NOT EXISTS provider_plans (
  connection_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS provider_quota_reset_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_resets_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  previous_remaining_percentage DOUBLE PRECISION,
  new_remaining_percentage DOUBLE PRECISION,
  previous_used_percentage DOUBLE PRECISION,
  new_used_percentage DOUBLE PRECISION,
  raw_data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(connection_id, window_key, window_started_at, window_resets_at)
);

CREATE INDEX IF NOT EXISTS idx_provider_quota_reset_events_connection_window
  ON provider_quota_reset_events(connection_id, window_key, window_resets_at);

CREATE TABLE IF NOT EXISTS proxy_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port BIGINT NOT NULL,
  username TEXT,
  password TEXT,
  region TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'manual',
  quality_score BIGINT,
  latency_ms BIGINT,
  anonymity TEXT,
  google_access BIGINT DEFAULT 0,
  last_validated TEXT,
  country_code TEXT,
  family TEXT NOT NULL DEFAULT 'auto'
);

CREATE TABLE IF NOT EXISTS proxy_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proxy_id TEXT NOT NULL REFERENCES proxy_registry(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  scope_id TEXT,
  position BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(scope, scope_id, proxy_id)
);
CREATE INDEX IF NOT EXISTS idx_proxy_assignments_proxy_id ON proxy_assignments(proxy_id);
CREATE INDEX IF NOT EXISTS idx_proxy_assignments_scope ON proxy_assignments(scope, scope_id);

CREATE TABLE IF NOT EXISTS proxy_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  status TEXT,
  proxy_type TEXT,
  proxy_host TEXT,
  proxy_port BIGINT,
  level TEXT,
  level_id TEXT,
  provider TEXT,
  target_url TEXT,
  public_ip TEXT,
  latency_ms BIGINT DEFAULT 0,
  error TEXT,
  connection_id TEXT,
  combo_id TEXT,
  account TEXT,
  tls_fingerprint BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proxy_scope_rotation (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'round-robin',
  cursor BIGINT NOT NULL DEFAULT 0,
  sticky_window_minutes BIGINT NOT NULL DEFAULT 30,
  rotated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS quota_allocation_model_caps (
  pool_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  cap_value DOUBLE PRECISION NOT NULL,
  cap_unit TEXT NOT NULL,
  PRIMARY KEY (pool_id, api_key_id, model)
);

CREATE TABLE IF NOT EXISTS quota_allocations (
  pool_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  weight DOUBLE PRECISION NOT NULL,
  cap_value DOUBLE PRECISION,
  cap_unit TEXT,
  policy TEXT NOT NULL DEFAULT 'hard',
  PRIMARY KEY (pool_id, api_key_id)
);

CREATE TABLE IF NOT EXISTS quota_consumption (
  api_key_id TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  bucket_index BIGINT NOT NULL,
  consumed DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (api_key_id, dimension_key, bucket_index)
);

CREATE TABLE IF NOT EXISTS quota_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quota_pool_connections (
  pool_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pool_id, connection_id)
);

CREATE TABLE IF NOT EXISTS quota_pools (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  group_id TEXT
);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  remaining_percentage DOUBLE PRECISION,
  is_exhausted BIGINT DEFAULT 0,
  next_reset_at TEXT,
  window_duration_ms BIGINT,
  raw_data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reasoning_cache (
  tool_call_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  char_count BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS registered_keys (
  id TEXT PRIMARY KEY,
  "key" TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  is_active BIGINT NOT NULL DEFAULT 1,
  revoked_at TEXT,
  expires_at TEXT,
  idempotency_key TEXT,
  daily_budget BIGINT,
  hourly_budget BIGINT,
  daily_used BIGINT NOT NULL DEFAULT 0,
  hourly_used BIGINT NOT NULL DEFAULT 0,
  last_reset_day TEXT NOT NULL DEFAULT '',
  last_reset_hour TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS relay_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id TEXT NOT NULL,
  request_id TEXT,
  model TEXT,
  prompt_tokens BIGINT DEFAULT 0,
  completion_tokens BIGINT DEFAULT 0,
  cost DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'success',
  status_code BIGINT DEFAULT 200,
  latency_ms BIGINT DEFAULT 0,
  client_ip TEXT,
  user_agent TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_rate_limits (
  token_id TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  request_count BIGINT DEFAULT 0,
  cost DOUBLE PRECISION DEFAULT 0,
  PRIMARY KEY (token_id, window_start)
);

CREATE TABLE IF NOT EXISTS relay_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  description TEXT DEFAULT '',
  combo_id TEXT,
  allowed_models TEXT DEFAULT '[]',
  max_tokens_per_request BIGINT DEFAULT 128000,
  max_requests_per_minute BIGINT DEFAULT 60,
  max_requests_per_day BIGINT DEFAULT 10000,
  max_cost_per_day DOUBLE PRECISION DEFAULT 0,
  enabled BIGINT DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  expires_at BIGINT,
  last_used_at BIGINT,
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS request_detail_logs (
  id TEXT PRIMARY KEY,
  call_log_id TEXT,
  timestamp TEXT NOT NULL,
  client_request TEXT,
  translated_request TEXT,
  provider_response TEXT,
  client_response TEXT,
  provider TEXT,
  model TEXT,
  source_format TEXT,
  target_format TEXT,
  duration_ms BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id TEXT,
  task_type TEXT,
  combo_id TEXT,
  provider_selected TEXT,
  model_selected TEXT,
  score DOUBLE PRECISION,
  factors_json TEXT,
  fallbacks_triggered BIGINT DEFAULT 0,
  success BIGINT DEFAULT 1,
  latency_ms BIGINT,
  cost DOUBLE PRECISION,
  source TEXT DEFAULT 'api',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS semantic_cache (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  tokens_saved BIGINT DEFAULT 0,
  hit_count BIGINT DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_account_affinity (
  session_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  PRIMARY KEY (session_key, provider)
);

CREATE TABLE IF NOT EXISTS session_model_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  combo_name TEXT NOT NULL,
  model_str TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_id TEXT,
  used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_executions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  session_id TEXT,
  input TEXT NOT NULL,
  output TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  duration_ms BIGINT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT,
  schema TEXT NOT NULL,
  handler TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  mode TEXT NOT NULL DEFAULT 'auto',
  source_provider TEXT,
  tags TEXT,
  install_count BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  sync_api_key_id TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tier_assignments (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  cost_per_1m_input DOUBLE PRECISION DEFAULT 0,
  cost_per_1m_output DOUBLE PRECISION DEFAULT 0,
  has_free_tier BIGINT DEFAULT 0,
  free_quota_limit BIGINT,
  reason TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS tier_config (
  "key" TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_api_key_id TEXT NOT NULL,
  to_api_key_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  reason TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS upstream_proxy_config (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'native',
  cliproxyapi_model_mapping TEXT,
  native_priority BIGINT NOT NULL DEFAULT 1,
  cliproxyapi_priority BIGINT NOT NULL DEFAULT 2,
  enabled BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  family TEXT NOT NULL DEFAULT 'auto'
);

CREATE TABLE IF NOT EXISTS usage_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT,
  model TEXT,
  connection_id TEXT,
  api_key_id TEXT,
  api_key_name TEXT,
  tokens_input BIGINT DEFAULT 0,
  tokens_output BIGINT DEFAULT 0,
  tokens_cache_read BIGINT DEFAULT 0,
  tokens_cache_creation BIGINT DEFAULT 0,
  tokens_reasoning BIGINT DEFAULT 0,
  service_tier TEXT DEFAULT 'standard',
  status TEXT,
  success BIGINT DEFAULT 1,
  latency_ms BIGINT DEFAULT 0,
  ttft_ms BIGINT DEFAULT 0,
  error_code TEXT,
  timestamp TEXT NOT NULL,
  combo_strategy TEXT DEFAULT 'direct',
  endpoint TEXT
);

CREATE TABLE IF NOT EXISTS user_badges (
  api_key_id TEXT NOT NULL,
  badge_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (api_key_id, badge_id)
);

CREATE TABLE IF NOT EXISTS user_levels (
  api_key_id TEXT PRIMARY KEY,
  total_xp BIGINT NOT NULL DEFAULT 0,
  current_level BIGINT NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS version_manager (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool TEXT NOT NULL UNIQUE,
  current_version TEXT,
  installed_version TEXT,
  pinned_version TEXT,
  binary_path TEXT,
  status TEXT NOT NULL DEFAULT 'not_installed',
  pid BIGINT,
  port BIGINT DEFAULT 8317,
  api_key TEXT,
  management_key TEXT,
  auto_update BIGINT NOT NULL DEFAULT 1,
  auto_start BIGINT NOT NULL DEFAULT 0,
  last_health_check TEXT,
  last_update_check TEXT,
  health_status TEXT DEFAULT 'unknown',
  config_overrides TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logs_buffer_path TEXT,
  provider_expose BIGINT NOT NULL DEFAULT 0,
  last_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status BIGINT,
  latency_ms BIGINT,
  error TEXT,
  payload_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  secret TEXT,
  enabled BIGINT DEFAULT 1,
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_triggered_at TEXT,
  last_status BIGINT,
  failure_count BIGINT DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'custom',
  metadata_encrypted TEXT
);

CREATE TABLE IF NOT EXISTS xp_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  action TEXT NOT NULL,
  xp_earned BIGINT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  variables TEXT,
  description TEXT,
  is_active BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(slug, version)
);
CREATE INDEX IF NOT EXISTS idx_pt_slug ON prompt_templates(slug);
CREATE INDEX IF NOT EXISTS idx_pt_active ON prompt_templates(slug, is_active);
CREATE INDEX IF NOT EXISTS idx_pt_hash ON prompt_templates(content_hash);
