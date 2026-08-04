CREATE TABLE discord_retry_reactions (
  guild_id text NOT NULL,
  message_id text NOT NULL,
  user_id text NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, message_id, user_id)
);

CREATE INDEX discord_retry_reactions_message_idx
  ON discord_retry_reactions (guild_id, message_id);
