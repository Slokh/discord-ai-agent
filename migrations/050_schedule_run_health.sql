ALTER TABLE scheduled_reminders
  ADD COLUMN last_run_at timestamptz,
  ADD COLUMN last_run_status text
    CHECK (last_run_status IN ('succeeded', 'partial', 'failed')),
  ADD COLUMN last_run_execution_id text,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  ADD COLUMN auto_paused_at timestamptz,
  ADD CONSTRAINT scheduled_reminders_last_run_state_check
    CHECK ((last_run_at IS NULL) = (last_run_status IS NULL)),
  ADD CONSTRAINT scheduled_reminders_auto_pause_state_check
    CHECK (auto_paused_at IS NULL OR status = 'paused');

CREATE INDEX scheduled_reminders_recent_health_idx
  ON scheduled_reminders(guild_id, requester_id, updated_at DESC, reminder_id)
  WHERE last_run_at IS NOT NULL OR status IN ('cancelled', 'failed');
