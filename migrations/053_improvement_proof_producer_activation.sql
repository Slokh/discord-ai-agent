CREATE TABLE IF NOT EXISTS improvement_proof_producers (
  trigger text PRIMARY KEY CHECK (trigger IN (
    'post_deploy_private_replay', 'release_promotion', 'production_observation'
  )),
  activated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO improvement_proof_producers(trigger) VALUES
  ('post_deploy_private_replay'),
  ('release_promotion'),
  ('production_observation')
ON CONFLICT(trigger) DO NOTHING;

ALTER TABLE improvement_proof_producer_runs
  DROP CONSTRAINT IF EXISTS improvement_proof_producer_runs_trigger_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'improvement_proof_producer_runs_trigger_fkey'
      AND conrelid = 'improvement_proof_producer_runs'::regclass
  ) THEN
    ALTER TABLE improvement_proof_producer_runs
      ADD CONSTRAINT improvement_proof_producer_runs_trigger_fkey
      FOREIGN KEY (trigger) REFERENCES improvement_proof_producers(trigger);
  END IF;
END $$;
