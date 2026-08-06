CREATE TABLE improvement_proof_producer_runs (
  run_id text PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN (
    'post_deploy_private_replay', 'release_promotion', 'production_observation'
  )),
  run_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  revision text,
  deployment_id text,
  outcome_code text,
  metadata jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(trigger, run_key),
  CHECK ((status = 'started' AND completed_at IS NULL) OR (status <> 'started' AND completed_at IS NOT NULL))
);

CREATE INDEX improvement_proof_producer_runs_health_idx
  ON improvement_proof_producer_runs(trigger, started_at DESC, run_id DESC);

ALTER TABLE improvement_verification_proofs
  DROP CONSTRAINT improvement_verification_proofs_source_check,
  ADD CONSTRAINT improvement_verification_proofs_source_check
    CHECK (source IN ('private_eval', 'revision_quality', 'schedule_health', 'producer_health'));
