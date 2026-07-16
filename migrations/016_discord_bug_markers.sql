CREATE TABLE IF NOT EXISTS discord_bug_markers (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, message_id, user_id)
);

CREATE INDEX IF NOT EXISTS discord_bug_markers_user_created_idx
  ON discord_bug_markers(guild_id, user_id, created_at DESC);
