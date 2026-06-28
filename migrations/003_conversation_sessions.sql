CREATE TABLE IF NOT EXISTS conversation_sessions (
  thread_key text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_sessions_guild_channel_idx
  ON conversation_sessions(guild_id, channel_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id bigserial PRIMARY KEY,
  thread_key text NOT NULL REFERENCES conversation_sessions(thread_key) ON DELETE CASCADE,
  discord_message_id text,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  author_id text,
  author_display_name text,
  content text NOT NULL DEFAULT '',
  parts jsonb NOT NULL DEFAULT '[]',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_thread_discord_message_idx
  ON conversation_messages(thread_key, discord_message_id)
  WHERE discord_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_messages_thread_created_idx
  ON conversation_messages(thread_key, created_at DESC, id DESC);
