-- Provably fair RNG (commit-reveal) sessions and draws.
--
-- A session commits to SHA-256(server_seed) before outcomes are produced.
-- Every entropy-consuming draw stores enough (nonce, kind, params, outcome)
-- for anyone to recompute the outcome from the revealed server seed and the
-- externally assigned client seed (the triggering Discord message id).

CREATE TABLE IF NOT EXISTS rng_sessions (
  id text PRIMARY KEY,
  thread_key text NOT NULL,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  created_by_user_id text NOT NULL,
  server_seed text NOT NULL,
  commitment text NOT NULL,
  client_seed text,
  client_seed_source text,
  nonce_counter integer NOT NULL DEFAULT 0,
  deck_count integer,
  shuffle_nonce integer,
  deck_position integer,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revealed')),
  prev_session_id text REFERENCES rng_sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revealed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS rng_sessions_active_thread_idx
  ON rng_sessions(thread_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS rng_sessions_guild_created_idx
  ON rng_sessions(guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rng_draws (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES rng_sessions(id) ON DELETE CASCADE,
  nonce integer NOT NULL,
  kind text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  outcome jsonb NOT NULL,
  reason text,
  request_id text,
  message_id text,
  requested_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rng_draws_session_idx
  ON rng_draws(session_id, id);
