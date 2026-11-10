-- nanocode keeps each agent session in its own schema, keyed by an opaque
-- session ID. This maps those sessions back to the Discord requester and
-- thread they belong to, so privacy deletion and retention can find them.
CREATE TABLE IF NOT EXISTS nanocode_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nanocode_sessions_user_idx ON nanocode_sessions (user_id);
CREATE INDEX IF NOT EXISTS nanocode_sessions_last_used_idx ON nanocode_sessions (last_used_at);
