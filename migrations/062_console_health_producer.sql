ALTER TABLE improvement_proof_producers
  DROP CONSTRAINT improvement_proof_producers_trigger_check,
  ADD CONSTRAINT improvement_proof_producers_trigger_check CHECK (trigger IN (
    'console_health', 'improvement_reconciliation', 'improvement_watchdog',
    'post_deploy_private_replay', 'release_promotion', 'production_observation'
  ));

INSERT INTO improvement_proof_producers(trigger) VALUES ('console_health')
ON CONFLICT(trigger) DO NOTHING;
