ALTER TABLE wallet_transfers
  DROP CONSTRAINT IF EXISTS wallet_transfers_purpose_check;

ALTER TABLE wallet_transfers
  ADD CONSTRAINT wallet_transfers_purpose_check
  CHECK (purpose IN (
    'initial_grant',
    'starter_grant',
    'game_settlement',
    'user_transfer',
    'admin_transfer',
    'reconciliation'
  ));

CREATE INDEX IF NOT EXISTS wallet_transfers_starter_destination_idx
  ON wallet_transfers(destination_wallet_id, token_address, confirmed_at)
  WHERE purpose = 'starter_grant';
