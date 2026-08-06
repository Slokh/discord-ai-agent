ALTER TABLE improvement_proof_producers
  DROP CONSTRAINT improvement_proof_producers_trigger_check,
  ADD CONSTRAINT improvement_proof_producers_trigger_check CHECK (trigger IN (
    'improvement_reconciliation', 'improvement_watchdog',
    'post_deploy_private_replay', 'release_promotion', 'production_observation'
  ));

INSERT INTO improvement_proof_producers(trigger) VALUES
  ('improvement_reconciliation'),
  ('improvement_watchdog')
ON CONFLICT(trigger) DO NOTHING;

CREATE TABLE improvement_bot_updates (
  update_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  source_key text NOT NULL UNIQUE,
  producer_trigger text NOT NULL REFERENCES improvement_proof_producers(trigger),
  liveness_reason text NOT NULL CHECK (liveness_reason IN (
    'missed_sla', 'run_in_progress_too_long', 'repeated_failures', 'latest_run_failed'
  )),
  delivery_channel_id text,
  delivery_message_id text,
  last_rendered_signature text,
  last_rendered_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_delivery_error text,
  next_delivery_at timestamptz,
  delivery_abandoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((delivery_channel_id IS NULL) = (delivery_message_id IS NULL))
);

CREATE INDEX improvement_bot_updates_render_idx
  ON improvement_bot_updates(next_delivery_at, updated_at)
  WHERE delivery_abandoned_at IS NULL;
