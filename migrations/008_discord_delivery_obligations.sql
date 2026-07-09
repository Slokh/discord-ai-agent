CREATE TABLE IF NOT EXISTS discord_delivery_obligations (
  execution_id text PRIMARY KEY,
  thread_key text,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  status_channel_id text,
  status_message_id text,
  source_message_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS discord_delivery_obligations_pending_idx
  ON discord_delivery_obligations(updated_at ASC, created_at ASC)
  WHERE state = 'pending';
