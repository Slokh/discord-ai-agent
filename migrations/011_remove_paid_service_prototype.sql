-- Retire the paid-service prototype while preserving managed wallets and transfers.

UPDATE wallet_transfers
SET purpose = 'reconciliation',
    metadata = metadata || '{"retiredPrototype":true}'::jsonb,
    updated_at = now()
WHERE purpose = 'mpp_payment';

ALTER TABLE wallet_transfers
  DROP CONSTRAINT IF EXISTS wallet_transfers_purpose_check;

ALTER TABLE wallet_transfers
  ADD CONSTRAINT wallet_transfers_purpose_check
  CHECK (purpose IN (
    'initial_grant',
    'game_settlement',
    'user_transfer',
    'admin_transfer',
    'reconciliation'
  ));

-- The retired MPP audit tables are deliberately retained. They are no longer
-- written or exposed by the runtime, but preserving them avoids destroying the
-- historical record during this cutover.
