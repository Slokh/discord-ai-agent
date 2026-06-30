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

CREATE TABLE IF NOT EXISTS process_run_artifact_chunks (
  artifact_id text NOT NULL REFERENCES process_run_artifacts(artifact_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (artifact_id, chunk_index)
);
