-- Safe, content-free detail for the existing case automation-health projection.
-- Verification receipts remain the immutable proof history; this column only
-- explains the latest pending state without creating another lifecycle.
ALTER TABLE improvement_cases
  ADD COLUMN automation_details jsonb NOT NULL DEFAULT '{}';
