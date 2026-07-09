CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guilds (
  id text PRIMARY KEY,
  name text,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discord_users (
  id text PRIMARY KEY,
  username text,
  global_name text,
  is_bot boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id text,
  name text,
  type integer NOT NULL,
  is_thread boolean NOT NULL DEFAULT false,
  is_excluded boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  discord_created_at timestamptz,
  last_message_id text,
  topic text,
  owner_id text,
  archived boolean,
  archive_timestamp timestamptz
);

CREATE INDEX IF NOT EXISTS channels_guild_parent_idx
  ON channels(guild_id, parent_id);

CREATE INDEX IF NOT EXISTS channels_guild_type_idx
  ON channels(guild_id, type);

CREATE INDEX IF NOT EXISTS channels_guild_discord_created_idx
  ON channels(guild_id, discord_created_at);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  thread_id text,
  author_id text NOT NULL REFERENCES discord_users(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  normalized_content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  message_type integer,
  is_pinned boolean,
  referenced_message_id text,
  referenced_channel_id text,
  referenced_guild_id text
);

CREATE INDEX IF NOT EXISTS messages_guild_channel_created_idx ON messages(guild_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_guild_created_idx ON messages(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_author_created_idx ON messages(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_text_idx ON messages USING gin(to_tsvector('english', normalized_content));

CREATE INDEX IF NOT EXISTS messages_reference_idx
  ON messages(referenced_message_id)
  WHERE referenced_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_guild_reference_idx
  ON messages(guild_id, referenced_channel_id, referenced_message_id)
  WHERE referenced_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_lower_content_trgm_idx
  ON messages USING gin (lower(normalized_content) gin_trgm_ops)
  WHERE deleted_at IS NULL AND normalized_content <> '';

CREATE INDEX IF NOT EXISTS messages_guild_channel_author_created_idx
  ON messages (guild_id, channel_id, author_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS messages_embedding_backlog_live_idx
  ON messages(guild_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND normalized_content <> '';

CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url text NOT NULL,
  proxy_url text,
  filename text,
  content_type text,
  size_bytes integer,
  raw jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS attachments_message_id_idx ON attachments(message_id);

CREATE INDEX IF NOT EXISTS attachments_lower_filename_trgm_idx
  ON attachments USING gin (lower(coalesce(filename, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS attachments_lower_content_type_prefix_idx
  ON attachments (lower(coalesce(content_type, '')) text_pattern_ops);

CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  dimensions integer NOT NULL DEFAULT 1536,
  input_version integer NOT NULL DEFAULT 1,
  input_text text NOT NULL DEFAULT '',
  input_sha256 text
);

CREATE INDEX IF NOT EXISTS message_embeddings_vector_idx
  ON message_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS message_embeddings_model_version_idx
  ON message_embeddings(model, dimensions, input_version);

CREATE TABLE IF NOT EXISTS crawl_cursors (
  channel_id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  before_message_id text,
  last_message_id text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  crawled_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discord_user_aliases (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES discord_users(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS discord_user_aliases_user_idx ON discord_user_aliases(guild_id, user_id);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES discord_users(id) ON DELETE CASCADE,
  display_name text,
  nickname text,
  roles text[] NOT NULL DEFAULT '{}',
  joined_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS guild_members_user_idx
  ON guild_members(user_id);

CREATE TABLE IF NOT EXISTS interaction_blocks (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS interaction_blocks_user_idx ON interaction_blocks(user_id);

CREATE TABLE IF NOT EXISTS privacy_deletions (
  user_id text PRIMARY KEY REFERENCES discord_users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  thread_key text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_sessions_guild_channel_idx
  ON conversation_sessions(guild_id, channel_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id bigserial PRIMARY KEY,
  thread_key text NOT NULL REFERENCES conversation_sessions(thread_key) ON DELETE CASCADE,
  discord_message_id text,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  author_id text,
  author_display_name text,
  content text NOT NULL DEFAULT '',
  parts jsonb NOT NULL DEFAULT '[]',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_thread_discord_message_idx
  ON conversation_messages(thread_key, discord_message_id)
  WHERE discord_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_messages_thread_created_idx
  ON conversation_messages(thread_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS conversation_messages_thread_id_idx
  ON conversation_messages(thread_key, id);

CREATE TABLE IF NOT EXISTS conversation_snapshots (
  snapshot_id bigserial PRIMARY KEY,
  thread_key text NOT NULL REFERENCES conversation_sessions(thread_key) ON DELETE CASCADE,
  summary text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  from_message_id bigint,
  to_message_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_snapshots_thread_created_idx
  ON conversation_snapshots(thread_key, created_at DESC, snapshot_id DESC);

CREATE TABLE IF NOT EXISTS skills (
  name text PRIMARY KEY,
  file_path text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'repo',
  content text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  last_pr_url text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_changes (
  id bigserial PRIMARY KEY,
  skill_name text NOT NULL,
  file_path text NOT NULL,
  requester_id text,
  request text,
  branch_name text,
  pr_url text,
  merged boolean NOT NULL DEFAULT false,
  policy_reasons jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skill_changes_skill_created_idx ON skill_changes(skill_name, created_at DESC);

CREATE TABLE IF NOT EXISTS server_overlays (
  guild_id text PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  system_prompt text NOT NULL DEFAULT '',
  tool_policy jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trace_events (
  id bigserial PRIMARY KEY,
  trace_id text NOT NULL,
  request_id text,
  guild_id text,
  channel_id text,
  user_id text,
  message_id text,
  event_name text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trace_events_trace_created_idx
  ON trace_events(trace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trace_events_guild_created_idx
  ON trace_events(guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trace_events_channel_created_idx
  ON trace_events(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_audit_logs (
  id bigserial PRIMARY KEY,
  trace_id text,
  guild_id text,
  channel_id text,
  user_id text,
  tool_name text NOT NULL,
  arguments_summary text,
  result_summary text,
  error text,
  model text,
  estimated_cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_audit_logs_trace_created_idx
  ON tool_audit_logs(trace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tool_audit_logs_guild_created_idx
  ON tool_audit_logs(guild_id, created_at DESC)
  WHERE guild_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_tasks (
  task_id text PRIMARY KEY,
  pgboss_job_id text,
  trace_id text,
  guild_id text,
  channel_id text,
  user_id text,
  thread_key text,
  discord_response_channel_id text,
  discord_response_message_id text,
  retried_from_task_id text REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  task_type text NOT NULL,
  title text NOT NULL,
  request text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  backend text,
  current_step text,
  status_message text,
  branch_name text,
  pr_url text,
  draft boolean,
  verify_passed boolean,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  notified_at timestamptz,
  notification_error text,
  progress_updated_at timestamptz,
  last_rendered_signature text,
  last_rendered_at timestamptz,
  terminal_rendered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_tasks_status_updated_idx
  ON agent_tasks(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS agent_tasks_guild_updated_idx
  ON agent_tasks(guild_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS agent_tasks_notification_idx
  ON agent_tasks(completed_at ASC)
  WHERE status IN ('succeeded', 'failed', 'no_changes', 'cancelled')
    AND notified_at IS NULL
    AND notification_error IS NULL
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_tasks_render_idx
  ON agent_tasks(coalesce(progress_updated_at, updated_at), status)
  WHERE notification_error IS NULL
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_tasks_trace_idx
  ON agent_tasks(trace_id);

CREATE INDEX IF NOT EXISTS agent_tasks_updated_created_idx
  ON agent_tasks(updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_tasks_stale_running_idx
  ON agent_tasks((coalesce(progress_updated_at, updated_at, started_at, created_at)), created_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS agent_tasks_live_message_backlog_idx
  ON agent_tasks(coalesce(progress_updated_at, updated_at) DESC, created_at DESC)
  WHERE status IN ('queued', 'running')
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_tasks_terminal_notification_idx
  ON agent_tasks(updated_at DESC, created_at DESC)
  WHERE status IN ('succeeded', 'failed', 'cancelled')
    AND notified_at IS NULL
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sandbox_runs (
  sandbox_run_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  backend text NOT NULL,
  namespace text,
  backend_job_name text,
  image text,
  status text NOT NULL DEFAULT 'running',
  metadata jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz,
  completed_at timestamptz,
  cleaned_up_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sandbox_runs_task_idx
  ON sandbox_runs(task_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sandbox_command_events (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  sandbox_run_id text,
  step text NOT NULL,
  command text,
  exit_code integer,
  output_tail text NOT NULL DEFAULT '',
  error_tail text NOT NULL DEFAULT '',
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sandbox_command_events_task_created_idx
  ON sandbox_command_events(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sandbox_command_events_created_idx
  ON sandbox_command_events(created_at, id);

CREATE TABLE IF NOT EXISTS process_runs (
  run_id text PRIMARY KEY,
  trace_id text,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  title text NOT NULL,
  summary text,
  guild_id text,
  channel_id text,
  user_id text,
  message_id text,
  requester text,
  source text NOT NULL DEFAULT 'app',
  metadata jsonb NOT NULL DEFAULT '{}',
  links jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS process_runs_updated_idx
  ON process_runs(updated_at DESC);

CREATE INDEX IF NOT EXISTS process_runs_trace_idx
  ON process_runs(trace_id)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS process_runs_kind_status_updated_idx
  ON process_runs(kind, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS process_run_spans (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES process_runs(run_id) ON DELETE CASCADE,
  span_id text NOT NULL,
  parent_span_id text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, span_id)
);

CREATE INDEX IF NOT EXISTS process_run_spans_run_started_idx
  ON process_run_spans(run_id, started_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS process_run_events (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES process_runs(run_id) ON DELETE CASCADE,
  trace_id text,
  level text NOT NULL DEFAULT 'info',
  event_name text NOT NULL,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS process_run_events_run_created_idx
  ON process_run_events(run_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS process_run_events_trace_created_idx
  ON process_run_events(trace_id, created_at DESC)
  WHERE trace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS process_run_artifacts (
  artifact_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES process_runs(run_id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  content_type text NOT NULL DEFAULT 'text/plain',
  size_bytes integer NOT NULL DEFAULT 0,
  preview text NOT NULL DEFAULT '',
  redacted boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS process_run_artifacts_run_created_idx
  ON process_run_artifacts(run_id, created_at ASC);

CREATE INDEX IF NOT EXISTS process_run_artifacts_expires_idx
  ON process_run_artifacts(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS process_run_artifact_chunks (
  artifact_id text NOT NULL REFERENCES process_run_artifacts(artifact_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (artifact_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
  session_id text PRIMARY KEY,
  trace_id text,
  thread_key text,
  guild_id text,
  channel_id text,
  user_id text,
  title text NOT NULL,
  request text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  harness text NOT NULL DEFAULT 'codex',
  model text,
  provider text,
  harness_thread_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runtime_sessions_trace_idx
  ON agent_runtime_sessions(trace_id)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_sessions_thread_updated_idx
  ON agent_runtime_sessions(thread_key, updated_at DESC)
  WHERE thread_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_sessions_status_updated_idx
  ON agent_runtime_sessions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_runtime_executions (
  execution_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_runtime_sessions(session_id) ON DELETE CASCADE,
  task_id text REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  trace_id text,
  attempt integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued',
  harness text NOT NULL DEFAULT 'codex-app-server',
  model text,
  provider text,
  reasoning_effort text,
  sandbox_id text,
  sandbox_run_id text,
  branch_name text,
  pr_url text,
  draft boolean,
  verify_passed boolean,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runtime_executions_session_attempt_idx
  ON agent_runtime_executions(session_id, attempt DESC);

CREATE INDEX IF NOT EXISTS agent_runtime_executions_task_idx
  ON agent_runtime_executions(task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_executions_status_updated_idx
  ON agent_runtime_executions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_runtime_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_runtime_sessions(session_id) ON DELETE CASCADE,
  execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE CASCADE,
  trace_id text,
  sequence integer NOT NULL,
  kind text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  event_name text NOT NULL,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(execution_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_runtime_events_execution_sequence_idx
  ON agent_runtime_events(execution_id, sequence ASC)
  WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_events_session_created_idx
  ON agent_runtime_events(session_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS agent_runtime_events_created_idx
  ON agent_runtime_events(created_at, id);

CREATE TABLE IF NOT EXISTS agent_runtime_messages (
  message_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_runtime_sessions(session_id) ON DELETE CASCADE,
  client_message_id text,
  role text NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runtime_messages_role_supported
    CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_messages_session_client_message_idx
  ON agent_runtime_messages(session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_messages_session_created_idx
  ON agent_runtime_messages(session_id, created_at ASC, message_id ASC);

CREATE TABLE IF NOT EXISTS agent_runtime_artifacts (
  artifact_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_runtime_sessions(session_id) ON DELETE CASCADE,
  execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  content_type text NOT NULL DEFAULT 'text/plain',
  size_bytes integer NOT NULL DEFAULT 0,
  preview text NOT NULL DEFAULT '',
  redacted boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runtime_artifacts_execution_created_idx
  ON agent_runtime_artifacts(execution_id, created_at ASC)
  WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_artifacts_session_created_idx
  ON agent_runtime_artifacts(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_runtime_artifact_chunks (
  artifact_id text NOT NULL REFERENCES agent_runtime_artifacts(artifact_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (artifact_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS agent_runtime_sandbox_leases (
  sandbox_id text PRIMARY KEY,
  repo text NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  lease_owner text,
  execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE SET NULL,
  heartbeat_at timestamptz,
  last_used_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runtime_sandbox_leases_repo_status_idx
  ON agent_runtime_sandbox_leases(repo, status, updated_at ASC);

CREATE TABLE IF NOT EXISTS discord_delivery_obligations (
  execution_id text PRIMARY KEY,
  thread_key text,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  status_channel_id text,
  status_message_id text,
  source_message_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS discord_delivery_obligations_pending_idx
  ON discord_delivery_obligations(updated_at ASC, created_at ASC)
  WHERE state = 'pending';
