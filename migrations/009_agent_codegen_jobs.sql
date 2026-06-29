CREATE TABLE IF NOT EXISTS agent_codegen_jobs (
  request_id text PRIMARY KEY,
  pgboss_job_id text,
  trace_id text,
  guild_id text,
  channel_id text,
  user_id text,
  update_name text NOT NULL,
  request text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  branch_name text,
  pr_url text,
  draft boolean,
  verify_passed boolean,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_codegen_jobs_status_updated_idx
  ON agent_codegen_jobs(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS agent_codegen_jobs_trace_idx
  ON agent_codegen_jobs(trace_id);
