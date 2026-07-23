CREATE TABLE IF NOT EXISTS wallet_guild_settings (
  guild_id text PRIMARY KEY,
  starter_target_usd numeric(9, 6) NOT NULL
    CHECK (starter_target_usd >= 0 AND starter_target_usd <= 100),
  updated_by_user_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
