-- Per-user daily chat-turn limit overrides.
--
-- When a row exists for (guild_id, user_id), chat_turns_per_day replaces the
-- global BUDGET_USER_TURNS_PER_DAY default for that user at Discord ingress.
-- 0 rejects every chat turn; -1 removes the daily limit for that user.

CREATE TABLE IF NOT EXISTS user_budget_overrides (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  chat_turns_per_day integer NOT NULL CHECK (chat_turns_per_day >= -1),
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
