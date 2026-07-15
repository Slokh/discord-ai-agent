-- Application-controlled Tempo wallets, auditable transfers, wager reservations,
-- and MPP payment state. Monetary values are stored in token base units.

CREATE TABLE IF NOT EXISTS wallet_accounts (
  id text PRIMARY KEY,
  guild_id text NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('bot', 'user')),
  discord_user_id text,
  provider text NOT NULL DEFAULT 'privy',
  provider_wallet_id text,
  external_id text NOT NULL UNIQUE,
  address text,
  chain_id integer NOT NULL,
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'error', 'disabled')),
  error_message text,
  provision_attempts integer NOT NULL DEFAULT 0,
  last_provision_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (owner_kind = 'bot' AND discord_user_id IS NULL)
    OR (owner_kind = 'user' AND discord_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_bot_guild_idx
  ON wallet_accounts(guild_id) WHERE owner_kind = 'bot';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_user_guild_idx
  ON wallet_accounts(guild_id, discord_user_id) WHERE owner_kind = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_provider_wallet_idx
  ON wallet_accounts(provider, provider_wallet_id) WHERE provider_wallet_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_accounts_address_chain_idx
  ON wallet_accounts(chain_id, lower(address)) WHERE address IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_transfers (
  id text PRIMARY KEY,
  guild_id text NOT NULL,
  requested_by_user_id text,
  source_wallet_id text REFERENCES wallet_accounts(id),
  destination_wallet_id text REFERENCES wallet_accounts(id),
  destination_address text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('initial_grant', 'game_settlement', 'mpp_payment', 'reconciliation')),
  token text NOT NULL,
  token_address text,
  token_decimals integer NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  amount_atomic numeric(78, 0) NOT NULL CHECK (amount_atomic > 0),
  idempotency_key text NOT NULL UNIQUE,
  memo_hex text NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'cancelled')),
  transaction_hash text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_transfers_guild_created_idx
  ON wallet_transfers(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_transfers_status_updated_idx
  ON wallet_transfers(status, updated_at) WHERE status IN ('submitting', 'submitted', 'unknown');
CREATE INDEX IF NOT EXISTS wallet_transfers_source_active_idx
  ON wallet_transfers(source_wallet_id, token, status);

ALTER TABLE wallet_accounts
  ADD COLUMN IF NOT EXISTS initial_grant_transfer_id text REFERENCES wallet_transfers(id);

CREATE TABLE IF NOT EXISTS wallet_wager_reservations (
  id text PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  thread_key text NOT NULL,
  requested_by_user_id text NOT NULL,
  user_wallet_id text NOT NULL REFERENCES wallet_accounts(id),
  bot_wallet_id text NOT NULL REFERENCES wallet_accounts(id),
  game text NOT NULL,
  token text NOT NULL,
  token_decimals integer NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  stake_atomic numeric(78, 0) NOT NULL CHECK (stake_atomic > 0),
  max_payout_atomic numeric(78, 0) NOT NULL CHECK (max_payout_atomic >= 0),
  payout_atomic numeric(78, 0),
  draw_id bigint REFERENCES rng_draws(id),
  settlement_transfer_id text REFERENCES wallet_transfers(id),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'drawn', 'settling', 'settled', 'released', 'expired', 'failed')),
  explanation text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_wagers_user_status_idx
  ON wallet_wager_reservations(user_wallet_id, token, status);
CREATE INDEX IF NOT EXISTS wallet_wagers_bot_status_idx
  ON wallet_wager_reservations(bot_wallet_id, token, status);
CREATE INDEX IF NOT EXISTS wallet_wagers_expiry_idx
  ON wallet_wager_reservations(expires_at) WHERE status IN ('reserved', 'drawn');

CREATE TABLE IF NOT EXISTS mpp_payment_attempts (
  id text PRIMARY KEY,
  guild_id text NOT NULL,
  requested_by_user_id text NOT NULL,
  execution_id text,
  request_fingerprint text NOT NULL,
  service_origin text NOT NULL,
  request_url text NOT NULL,
  request_method text NOT NULL,
  challenge_id text,
  payment_method text,
  payment_intent text,
  currency text,
  amount_atomic numeric(78, 0),
  amount_usd_micros bigint,
  decimals integer,
  recipient text,
  chain_id integer,
  transfer_id text REFERENCES wallet_transfers(id),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'challenged', 'approved', 'paid', 'succeeded', 'rejected', 'failed')),
  http_status integer,
  response_content_type text,
  response_bytes integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mpp_payment_attempts_execution_fingerprint_idx
  ON mpp_payment_attempts(execution_id, request_fingerprint)
  WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mpp_payment_attempts_user_daily_idx
  ON mpp_payment_attempts(guild_id, requested_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mpp_payment_attempts_bot_daily_idx
  ON mpp_payment_attempts(guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mpp_channel_store (
  guild_id text NOT NULL,
  store_key text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, store_key)
);
