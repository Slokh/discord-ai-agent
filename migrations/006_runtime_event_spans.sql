ALTER TABLE agent_runtime_events
  ADD COLUMN IF NOT EXISTS span_id text,
  ADD COLUMN IF NOT EXISTS parent_span_id text;

CREATE INDEX IF NOT EXISTS agent_runtime_events_execution_span_idx
  ON agent_runtime_events(execution_id, span_id)
  WHERE execution_id IS NOT NULL AND span_id IS NOT NULL;

CREATE OR REPLACE VIEW agent_runtime_trace_projection AS
SELECT id, session_id, execution_id, trace_id, sequence, kind, level,
       event_name, summary, metadata, duration_ms, span_id, parent_span_id, created_at
FROM agent_runtime_events;

CREATE TABLE IF NOT EXISTS agent_run_feedback (
  run_id text PRIMARY KEY,
  rating text NOT NULL CHECK (rating IN ('good', 'bad')),
  note text,
  expected_behavior text,
  capture_eval boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_run_feedback_eval_idx
  ON agent_run_feedback(updated_at DESC)
  WHERE capture_eval = true;

CREATE OR REPLACE VIEW agent_runtime_tool_audit_projection AS
SELECT id, session_id, execution_id, trace_id, event_name,
       metadata->>'toolName' AS tool_name,
       level, summary, duration_ms, metadata, created_at
FROM agent_runtime_events
WHERE metadata->>'category' = 'tool';

CREATE OR REPLACE VIEW agent_runtime_metric_projection AS
SELECT id, session_id, execution_id, trace_id, event_name,
       metadata->>'category' AS category,
       metadata->>'phase' AS phase,
       duration_ms,
       CASE WHEN metadata->>'estimatedCostUsd' ~ '^[0-9]+([.][0-9]+)?$'
         THEN (metadata->>'estimatedCostUsd')::double precision END AS estimated_cost_usd,
       CASE WHEN metadata#>>'{usage,inputTokens}' ~ '^[0-9]+$'
         THEN (metadata#>>'{usage,inputTokens}')::bigint END AS input_tokens,
       CASE WHEN metadata#>>'{usage,outputTokens}' ~ '^[0-9]+$'
         THEN (metadata#>>'{usage,outputTokens}')::bigint END AS output_tokens,
       CASE WHEN metadata#>>'{usage,cachedInputTokens}' ~ '^[0-9]+$'
         THEN (metadata#>>'{usage,cachedInputTokens}')::bigint END AS cached_input_tokens,
       created_at
FROM agent_runtime_events;
