CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guilds (
  id text PRIMARY KEY,
  name text,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discord_users (
  id text PRIMARY KEY,
  username text,
  global_name text,
  is_bot boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id text,
  name text,
  type integer NOT NULL,
  is_thread boolean NOT NULL DEFAULT false,
  is_excluded boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  thread_id text,
  author_id text NOT NULL REFERENCES discord_users(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  normalized_content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_guild_channel_created_idx ON messages(guild_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_author_created_idx ON messages(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_text_idx ON messages USING gin(to_tsvector('english', normalized_content));

CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url text NOT NULL,
  proxy_url text,
  filename text,
  content_type text,
  size_bytes integer,
  raw jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_embeddings_vector_idx
  ON message_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS crawl_cursors (
  channel_id text PRIMARY KEY,
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  before_message_id text,
  last_message_id text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  crawled_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS privacy_deletions (
  user_id text PRIMARY KEY REFERENCES discord_users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_audit_logs (
  id bigserial PRIMARY KEY,
  guild_id text,
  channel_id text,
  user_id text,
  tool_name text NOT NULL,
  arguments_summary text,
  result_summary text,
  error text,
  model text,
  estimated_cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
