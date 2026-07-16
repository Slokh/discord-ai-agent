ALTER TABLE wallet_wager_reservations
  ADD COLUMN IF NOT EXISTS request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_wagers_request_id_unique_idx
  ON wallet_wager_reservations(request_id)
  WHERE request_id IS NOT NULL AND status NOT IN ('released', 'expired', 'failed');
