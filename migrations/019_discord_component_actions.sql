CREATE TABLE IF NOT EXISTS discord_component_actions (
  token_hash text PRIMARY KEY,
  originating_execution_id text NOT NULL REFERENCES agent_runtime_executions(execution_id) ON DELETE CASCADE,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  source_message_id text NOT NULL,
  response_message_id text,
  owner_user_id text,
  audience text NOT NULL CHECK (audience IN ('requester', 'channel')),
  action_kind text NOT NULL CHECK (action_kind IN ('continue', 'select', 'modal')),
  payload jsonb NOT NULL,
  single_use boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'consumed', 'expired')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discord_component_actions_message_idx
  ON discord_component_actions(guild_id, channel_id, response_message_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS discord_component_actions_expiry_idx
  ON discord_component_actions(expires_at)
  WHERE state = 'active';
