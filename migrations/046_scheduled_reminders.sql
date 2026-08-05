CREATE TABLE scheduled_reminders (
  reminder_id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  requester_id text NOT NULL,
  source_message_id text NOT NULL,
  reminder_text text NOT NULL CHECK (char_length(reminder_text) BETWEEN 1 AND 1500),
  timezone text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'delivering', 'delivered', 'cancelled', 'failed')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  claimed_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  delivery_channel_id text,
  delivery_message_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_reminders_due_idx
  ON scheduled_reminders(scheduled_for, reminder_id)
  WHERE status = 'scheduled';

CREATE INDEX scheduled_reminders_stale_claim_idx
  ON scheduled_reminders(claimed_at, reminder_id)
  WHERE status = 'delivering';

CREATE INDEX scheduled_reminders_requester_idx
  ON scheduled_reminders(guild_id, requester_id, scheduled_for, reminder_id)
  WHERE status = 'scheduled';

CREATE INDEX scheduled_reminders_terminal_retention_idx
  ON scheduled_reminders(updated_at, reminder_id)
  WHERE status IN ('delivered', 'cancelled', 'failed');
