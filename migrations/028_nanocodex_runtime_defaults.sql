ALTER TABLE agent_runtime_sessions
  ALTER COLUMN harness SET DEFAULT 'nanocodex';

ALTER TABLE agent_runtime_executions
  ALTER COLUMN harness SET DEFAULT 'nanocodex';
