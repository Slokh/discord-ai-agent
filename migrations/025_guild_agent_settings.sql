CREATE TABLE IF NOT EXISTS guild_agent_settings (
  guild_id text PRIMARY KEY,
  chat_model text NOT NULL
    CHECK (
      char_length(chat_model) BETWEEN 3 AND 200
      AND chat_model ~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  updated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
