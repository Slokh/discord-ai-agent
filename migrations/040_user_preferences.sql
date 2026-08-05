CREATE TABLE IF NOT EXISTS user_preferences (
  user_id text NOT NULL,
  preference_key text NOT NULL
    CHECK (
      char_length(preference_key) BETWEEN 1 AND 100
      AND preference_key ~ '^[a-z][a-z0-9_]*$'
    ),
  preference_value jsonb NOT NULL
    CHECK (
      jsonb_typeof(preference_value) <> 'null'
      AND pg_column_size(preference_value) <= 4096
    ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, preference_key)
);
