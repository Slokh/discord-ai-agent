ALTER TABLE wallet_wager_reservations
  ADD COLUMN IF NOT EXISTS interaction_mode text NOT NULL DEFAULT 'automatic'
    CHECK (interaction_mode IN ('automatic', 'player_decisions')),
  ADD COLUMN IF NOT EXISTS settlement_outcome text
    CHECK (settlement_outcome IN ('player_win', 'player_loss', 'push')),
  ADD COLUMN IF NOT EXISTS settlement_resolution_source text
    CHECK (settlement_resolution_source IN ('verified_randomness', 'player_decision')),
  ADD COLUMN IF NOT EXISTS settlement_request_id text;
