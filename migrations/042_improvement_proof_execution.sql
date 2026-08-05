ALTER TABLE improvement_verification_proofs
  ADD COLUMN execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE SET NULL,
  ADD COLUMN check_results jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(check_results) = 'array');

CREATE INDEX improvement_verification_proofs_execution_idx
  ON improvement_verification_proofs(execution_id)
  WHERE execution_id IS NOT NULL;
