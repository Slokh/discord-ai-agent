CREATE TABLE IF NOT EXISTS discord_user_aliases (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES discord_users(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS discord_user_aliases_user_idx ON discord_user_aliases(guild_id, user_id);
