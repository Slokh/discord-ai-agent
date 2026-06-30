CREATE EXTENSION IF NOT EXISTS vector;

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
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_guild_channel_created_idx ON messages(guild_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_guild_created_idx ON messages(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_author_created_idx ON messages(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_text_idx ON messages USING gin(to_tsvector('english', normalized_content));

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

CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_embeddings_vector_idx
  ON message_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

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

CREATE TABLE IF NOT EXISTS durable_workflows (
  id text PRIMARY KEY,
  guild_id text REFERENCES guilds(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'paused',
  schedule text,
  state jsonb NOT NULL DEFAULT '{}',
  last_started_at timestamptz,
  last_completed_at timestamptz,
  next_run_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS durable_workflows_due_idx
  ON durable_workflows(status, next_run_at)
  WHERE next_run_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS durable_workflows_guild_idx
  ON durable_workflows(guild_id, status, updated_at DESC);

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

CREATE TABLE IF NOT EXISTS task_events (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  trace_id text,
  event_name text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_events_task_created_idx
  ON task_events(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_events_trace_created_idx
  ON task_events(trace_id, created_at DESC);

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

CREATE TABLE IF NOT EXISTS warm_sandboxes (
  sandbox_id text PRIMARY KEY,
  backend text NOT NULL,
  repo_key text NOT NULL,
  namespace text,
  pod_name text,
  image text,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'ready', 'leased', 'failed', 'draining')),
  lease_task_id text REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  lease_owner text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  last_used_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warm_sandboxes_ready_idx
  ON warm_sandboxes(repo_key, created_at)
  WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS warm_sandboxes_lease_idx
  ON warm_sandboxes(status, lease_expires_at)
  WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS warm_sandboxes_repo_status_idx
  ON warm_sandboxes(repo_key, status, updated_at DESC);
