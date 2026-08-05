-- One channel-scoped follow-up conversation per reported Discord message. The
-- improvement case remains the lifecycle source of truth; conversations only
-- project that lifecycle into Discord and retain the current clarification.
CREATE TABLE improvement_reporter_conversations (
  conversation_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  guild_id text NOT NULL,
  source_channel_id text NOT NULL,
  source_message_id text NOT NULL,
  delivery_kind text CHECK (delivery_kind IS NULL OR delivery_kind IN ('thread', 'dm')),
  delivery_channel_id text,
  delivery_message_id text,
  clarification_task_id text,
  clarification_question text CHECK (clarification_question IS NULL OR length(clarification_question) BETWEEN 1 AND 1000),
  clarification_answer text,
  answer_signal_id text REFERENCES improvement_signals(signal_id) ON DELETE SET NULL,
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
  UNIQUE(guild_id, source_message_id),
  CHECK ((delivery_kind IS NULL) = (delivery_channel_id IS NULL)),
  CHECK ((delivery_channel_id IS NULL) = (delivery_message_id IS NULL))
);

CREATE TABLE improvement_reporter_conversation_signals (
  conversation_id text NOT NULL REFERENCES improvement_reporter_conversations(conversation_id) ON DELETE CASCADE,
  signal_id text PRIMARY KEY REFERENCES improvement_signals(signal_id) ON DELETE CASCADE,
  reporter_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX improvement_reporter_conversation_signals_conversation_idx
  ON improvement_reporter_conversation_signals(conversation_id, created_at);

CREATE INDEX improvement_reporter_conversations_render_idx
  ON improvement_reporter_conversations(next_delivery_at, updated_at)
  WHERE delivery_abandoned_at IS NULL;

CREATE INDEX improvement_reporter_conversations_reply_idx
  ON improvement_reporter_conversations(delivery_kind, delivery_channel_id, delivery_message_id)
  WHERE clarification_question IS NOT NULL AND clarification_answer IS NULL;
