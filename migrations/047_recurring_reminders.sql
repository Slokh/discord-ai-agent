ALTER TABLE scheduled_reminders
  DROP CONSTRAINT scheduled_reminders_status_check,
  ADD COLUMN recurrence jsonb,
  ADD COLUMN occurrence_sequence integer NOT NULL DEFAULT 0 CHECK (occurrence_sequence >= 0),
  ADD COLUMN paused_at timestamptz,
  ADD CONSTRAINT scheduled_reminders_status_check
    CHECK (status IN ('scheduled', 'delivering', 'delivered', 'paused', 'cancelled', 'failed')),
  ADD CONSTRAINT scheduled_reminders_recurrence_object_check
    CHECK (recurrence IS NULL OR jsonb_typeof(recurrence) = 'object'),
  ADD CONSTRAINT scheduled_reminders_paused_state_check
    CHECK ((status = 'paused') = (paused_at IS NOT NULL));

DROP INDEX scheduled_reminders_requester_idx;

CREATE INDEX scheduled_reminders_requester_idx
  ON scheduled_reminders(guild_id, requester_id, scheduled_for, reminder_id)
  WHERE status IN ('scheduled', 'paused');
