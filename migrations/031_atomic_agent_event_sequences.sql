ALTER TABLE agent_runtime_sessions
  ADD COLUMN IF NOT EXISTS event_sequence integer NOT NULL DEFAULT 0;

ALTER TABLE agent_runtime_executions
  ADD COLUMN IF NOT EXISTS event_sequence integer NOT NULL DEFAULT 0;

UPDATE agent_runtime_sessions session
SET event_sequence = greatest(session.event_sequence, events.max_sequence)
FROM (
  SELECT session_id, max(sequence)::integer AS max_sequence
  FROM agent_runtime_events
  WHERE execution_id IS NULL
  GROUP BY session_id
) events
WHERE session.session_id = events.session_id;

UPDATE agent_runtime_executions execution
SET event_sequence = greatest(execution.event_sequence, events.max_sequence)
FROM (
  SELECT execution_id, max(sequence)::integer AS max_sequence
  FROM agent_runtime_events
  WHERE execution_id IS NOT NULL
  GROUP BY execution_id
) events
WHERE execution.execution_id = events.execution_id;
