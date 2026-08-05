-- Durable watchdog projection on the canonical improvement case. This does not
-- replace lifecycle status; it explains who or what can advance that status.
ALTER TABLE improvement_cases
  ADD COLUMN automation_state text NOT NULL DEFAULT 'pending'
    CHECK (automation_state IN ('pending', 'progressing', 'waiting', 'blocked', 'complete')),
  ADD COLUMN automation_blocker text,
  ADD COLUMN automation_next_action text NOT NULL DEFAULT 'reconcile',
  ADD COLUMN automation_retry_trigger text,
  ADD COLUMN automation_retry_at timestamptz,
  ADD COLUMN automation_progress_key text NOT NULL DEFAULT '',
  ADD COLUMN automation_last_progress_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN automation_checked_at timestamptz NOT NULL DEFAULT now();

UPDATE improvement_cases SET
  automation_state = CASE WHEN status IN ('resolved', 'dismissed') THEN 'complete' ELSE 'pending' END,
  automation_next_action = CASE WHEN status IN ('resolved', 'dismissed') THEN 'none' ELSE 'reconcile' END,
  automation_progress_key = status || ':' || version::text,
  automation_last_progress_at = updated_at,
  automation_checked_at = updated_at;

CREATE INDEX improvement_cases_automation_health_idx
  ON improvement_cases(automation_state, automation_checked_at, case_id)
  WHERE merged_into_case_id IS NULL AND status NOT IN ('resolved', 'dismissed');
