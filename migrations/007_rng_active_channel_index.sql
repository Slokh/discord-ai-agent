-- Standalone RNG reveals resolve the requester's most recently drawn active
-- reply-chain session in the current channel. Keep that lookup bounded as
-- reply-root-scoped active sessions accumulate over time.

CREATE INDEX IF NOT EXISTS rng_sessions_active_channel_idx
  ON rng_sessions(channel_id, created_at DESC)
  WHERE status = 'active';
