ALTER TABLE agent_run_feedback
  ADD COLUMN IF NOT EXISTS failure_mode text,
  ADD COLUMN IF NOT EXISTS expected_tools text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS forbidden_tools text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS must_contain text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS must_not_contain text[] NOT NULL DEFAULT '{}';

ALTER TABLE agent_run_feedback
  DROP CONSTRAINT IF EXISTS agent_run_feedback_failure_mode_supported;

ALTER TABLE agent_run_feedback
  ADD CONSTRAINT agent_run_feedback_failure_mode_supported CHECK (
    failure_mode IS NULL OR failure_mode IN (
      'wrong_answer', 'unnecessary_refusal', 'wrong_tool', 'missing_evidence',
      'permission', 'delivery', 'latency', 'other'
    )
  );
