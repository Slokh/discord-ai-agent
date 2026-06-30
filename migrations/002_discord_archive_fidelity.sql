CREATE TABLE IF NOT EXISTS guild_members (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES discord_users(id) ON DELETE CASCADE,
  display_name text,
  nickname text,
  roles text[] NOT NULL DEFAULT '{}',
  joined_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS guild_members_user_idx
  ON guild_members(user_id);

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS discord_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_message_id text,
  ADD COLUMN IF NOT EXISTS topic text,
  ADD COLUMN IF NOT EXISTS owner_id text,
  ADD COLUMN IF NOT EXISTS archived boolean,
  ADD COLUMN IF NOT EXISTS archive_timestamp timestamptz;

CREATE INDEX IF NOT EXISTS channels_guild_parent_idx
  ON channels(guild_id, parent_id);

CREATE INDEX IF NOT EXISTS channels_guild_type_idx
  ON channels(guild_id, type);

CREATE INDEX IF NOT EXISTS channels_guild_discord_created_idx
  ON channels(guild_id, discord_created_at);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type integer,
  ADD COLUMN IF NOT EXISTS is_pinned boolean,
  ADD COLUMN IF NOT EXISTS referenced_message_id text,
  ADD COLUMN IF NOT EXISTS referenced_channel_id text,
  ADD COLUMN IF NOT EXISTS referenced_guild_id text;

CREATE INDEX IF NOT EXISTS messages_reference_idx
  ON messages(referenced_message_id)
  WHERE referenced_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_guild_reference_idx
  ON messages(guild_id, referenced_channel_id, referenced_message_id)
  WHERE referenced_message_id IS NOT NULL;

ALTER TABLE message_embeddings
  ADD COLUMN IF NOT EXISTS dimensions integer NOT NULL DEFAULT 1536,
  ADD COLUMN IF NOT EXISTS input_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS input_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS input_sha256 text;

CREATE INDEX IF NOT EXISTS message_embeddings_model_version_idx
  ON message_embeddings(model, dimensions, input_version);
