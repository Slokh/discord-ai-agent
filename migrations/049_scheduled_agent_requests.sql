ALTER TABLE scheduled_reminders
  ADD COLUMN delivery_kind text NOT NULL DEFAULT 'notification'
    CHECK (delivery_kind IN ('notification', 'agent'));
