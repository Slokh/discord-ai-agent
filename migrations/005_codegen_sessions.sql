CREATE TABLE IF NOT EXISTS codegen_sessions (
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
  codex_thread_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codegen_sessions_trace_idx
  ON codegen_sessions(trace_id)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS codegen_sessions_thread_updated_idx
  ON codegen_sessions(thread_key, updated_at DESC)
  WHERE thread_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS codegen_sessions_status_updated_idx
  ON codegen_sessions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS codegen_executions (
  execution_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES codegen_sessions(session_id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS codegen_executions_session_attempt_idx
  ON codegen_executions(session_id, attempt DESC);

CREATE INDEX IF NOT EXISTS codegen_executions_task_idx
  ON codegen_executions(task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS codegen_executions_status_updated_idx
  ON codegen_executions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS codegen_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES codegen_sessions(session_id) ON DELETE CASCADE,
  execution_id text REFERENCES codegen_executions(execution_id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS codegen_events_execution_sequence_idx
  ON codegen_events(execution_id, sequence ASC)
  WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS codegen_events_session_created_idx
  ON codegen_events(session_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS codegen_artifacts (
  artifact_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES codegen_sessions(session_id) ON DELETE CASCADE,
  execution_id text REFERENCES codegen_executions(execution_id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS codegen_artifacts_execution_created_idx
  ON codegen_artifacts(execution_id, created_at ASC)
  WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS codegen_artifacts_session_created_idx
  ON codegen_artifacts(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS codegen_artifact_chunks (
  artifact_id text NOT NULL REFERENCES codegen_artifacts(artifact_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (artifact_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS codegen_sandbox_leases (
  sandbox_id text PRIMARY KEY,
  repo text NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  lease_owner text,
  execution_id text REFERENCES codegen_executions(execution_id) ON DELETE SET NULL,
  heartbeat_at timestamptz,
  last_used_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codegen_sandbox_leases_repo_status_idx
  ON codegen_sandbox_leases(repo, status, updated_at ASC);
