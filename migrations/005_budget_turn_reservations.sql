CREATE TABLE IF NOT EXISTS budget_turn_reservations (
  request_id text PRIMARY KEY,
  guild_id text NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS budget_turn_reservations_guild_user_created_idx
  ON budget_turn_reservations(guild_id, user_id, created_at DESC);
