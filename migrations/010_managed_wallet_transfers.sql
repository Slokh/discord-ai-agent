-- Managed-wallet transfers and token-scoped initial grants.

ALTER TABLE wallet_transfers
  DROP CONSTRAINT IF EXISTS wallet_transfers_purpose_check;

ALTER TABLE wallet_transfers
  ADD CONSTRAINT wallet_transfers_purpose_check
  CHECK (purpose IN (
    'initial_grant',
    'game_settlement',
    'user_transfer',
    'admin_transfer',
    'mpp_payment',
    'reconciliation'
  ));

CREATE TABLE IF NOT EXISTS wallet_initial_grants (
  wallet_id text NOT NULL REFERENCES wallet_accounts(id),
  token_address text NOT NULL,
  transfer_id text NOT NULL UNIQUE REFERENCES wallet_transfers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, token_address)
);

INSERT INTO wallet_initial_grants(wallet_id, token_address, transfer_id)
SELECT destination_wallet_id, lower(token_address), id
FROM wallet_transfers
WHERE purpose = 'initial_grant'
  AND destination_wallet_id IS NOT NULL
  AND token_address IS NOT NULL
ON CONFLICT (wallet_id, token_address) DO NOTHING;

CREATE INDEX IF NOT EXISTS wallet_transfers_destination_created_idx
  ON wallet_transfers(destination_wallet_id, created_at DESC)
  WHERE destination_wallet_id IS NOT NULL;
