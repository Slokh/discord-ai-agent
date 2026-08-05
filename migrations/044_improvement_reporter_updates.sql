-- One durable private Discord conversation per original member report. The case
-- remains the lifecycle source of truth; this table only tracks reporter-facing
-- delivery and the current clarification turn.
CREATE TABLE improvement_reporter_updates (
  update_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  signal_id text NOT NULL UNIQUE REFERENCES improvement_signals(signal_id) ON DELETE CASCADE,
  reporter_id text NOT NULL,
  clarification_task_id text,
  clarification_question text CHECK (clarification_question IS NULL OR length(clarification_question) BETWEEN 1 AND 1000),
  clarification_answer text,
  answer_signal_id text REFERENCES improvement_signals(signal_id) ON DELETE SET NULL,
  dm_channel_id text,
  dm_message_id text,
  last_rendered_signature text,
  last_rendered_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_delivery_error text,
  next_delivery_at timestamptz,
  delivery_abandoned_at timestamptz,
  clarification_requested_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((dm_channel_id IS NULL) = (dm_message_id IS NULL))
);

CREATE INDEX improvement_reporter_updates_render_idx
  ON improvement_reporter_updates(next_delivery_at, updated_at)
  WHERE delivery_abandoned_at IS NULL;

CREATE INDEX improvement_reporter_updates_reply_idx
  ON improvement_reporter_updates(reporter_id, dm_channel_id, dm_message_id)
  WHERE clarification_question IS NOT NULL AND clarification_answer IS NULL;
