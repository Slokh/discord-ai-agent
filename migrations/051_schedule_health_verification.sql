ALTER TABLE improvement_verification_proofs
  DROP CONSTRAINT improvement_verification_proofs_source_check,
  ADD CONSTRAINT improvement_verification_proofs_source_check
    CHECK (source IN ('private_eval', 'revision_quality', 'schedule_health'));
