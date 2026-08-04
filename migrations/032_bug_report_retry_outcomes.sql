ALTER TABLE discord_bug_reports
  ADD COLUMN IF NOT EXISTS retry_status text,
  ADD COLUMN IF NOT EXISTS retry_execution_id text,
  ADD COLUMN IF NOT EXISTS announcement_message_id text,
  ADD COLUMN IF NOT EXISTS retried_at timestamptz;

ALTER TABLE discord_bug_reports
  DROP CONSTRAINT IF EXISTS discord_bug_reports_retry_status_check;

ALTER TABLE discord_bug_reports
  ADD CONSTRAINT discord_bug_reports_retry_status_check
  CHECK (retry_status IS NULL OR retry_status IN ('running', 'succeeded', 'failed'));
