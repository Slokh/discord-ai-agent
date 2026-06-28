ALTER TABLE tool_audit_logs
  ADD COLUMN IF NOT EXISTS trace_id text;

CREATE INDEX IF NOT EXISTS tool_audit_logs_trace_created_idx
  ON tool_audit_logs(trace_id, created_at DESC);

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
