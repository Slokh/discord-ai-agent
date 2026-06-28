CREATE TABLE IF NOT EXISTS interaction_blocks (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS interaction_blocks_user_idx
  ON interaction_blocks(user_id);
