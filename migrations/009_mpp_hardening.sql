ALTER TABLE mpp_payment_attempts
  ADD COLUMN IF NOT EXISTS service_id text,
  ADD COLUMN IF NOT EXISTS inspection_id text,
  ADD COLUMN IF NOT EXISTS operation_id text,
  ADD COLUMN IF NOT EXISTS effect text,
  ADD COLUMN IF NOT EXISTS approval_mode text,
  ADD COLUMN IF NOT EXISTS receipt_method text,
  ADD COLUMN IF NOT EXISTS receipt_reference text,
  ADD COLUMN IF NOT EXISTS receipt_status text,
  ADD COLUMN IF NOT EXISTS receipt_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_external_id text,
  ADD COLUMN IF NOT EXISTS receipt jsonb;

ALTER TABLE mpp_payment_attempts
  DROP CONSTRAINT IF EXISTS mpp_payment_attempts_status_check;

ALTER TABLE mpp_payment_attempts
  ADD CONSTRAINT mpp_payment_attempts_status_check
  CHECK (status IN ('started', 'challenged', 'approved', 'paid', 'succeeded', 'rejected', 'failed', 'uncertain'));

ALTER TABLE mpp_payment_attempts
  DROP CONSTRAINT IF EXISTS mpp_payment_attempts_effect_check;

ALTER TABLE mpp_payment_attempts
  ADD CONSTRAINT mpp_payment_attempts_effect_check
  CHECK (effect IS NULL OR effect IN ('read_only', 'external_side_effect'));

ALTER TABLE mpp_payment_attempts
  DROP CONSTRAINT IF EXISTS mpp_payment_attempts_approval_mode_check;

ALTER TABLE mpp_payment_attempts
  ADD CONSTRAINT mpp_payment_attempts_approval_mode_check
  CHECK (approval_mode IS NULL OR approval_mode IN ('automatic_low_cost', 'explicit_user'));

CREATE INDEX IF NOT EXISTS mpp_payment_attempts_recent_fingerprint_idx
  ON mpp_payment_attempts(guild_id, requested_by_user_id, request_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS mpp_payment_attempts_receipt_reference_idx
  ON mpp_payment_attempts(receipt_reference)
  WHERE receipt_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_runtime_health (
  health_key text PRIMARY KEY,
  status text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);

-- Wallet ownership and reusable payment channels are chain-specific. Preserve
-- the original Moderato rows while allowing a mainnet cutover in the same DB.
DROP INDEX IF EXISTS wallet_accounts_bot_guild_idx;
DROP INDEX IF EXISTS wallet_accounts_user_guild_idx;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_bot_guild_chain_idx
  ON wallet_accounts(guild_id, chain_id) WHERE owner_kind = 'bot';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_user_guild_chain_idx
  ON wallet_accounts(guild_id, discord_user_id, chain_id) WHERE owner_kind = 'user';

ALTER TABLE mpp_channel_store
  ADD COLUMN IF NOT EXISTS chain_id integer;

UPDATE mpp_channel_store SET chain_id = 42431 WHERE chain_id IS NULL;

ALTER TABLE mpp_channel_store
  ALTER COLUMN chain_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS mpp_channel_store_pkey;

ALTER TABLE mpp_channel_store
  ADD CONSTRAINT mpp_channel_store_pkey PRIMARY KEY (guild_id, chain_id, store_key);
