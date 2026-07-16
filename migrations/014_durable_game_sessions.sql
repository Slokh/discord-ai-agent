ALTER TABLE wallet_wager_reservations
  ADD COLUMN IF NOT EXISTS awaiting_action boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS state_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS decision_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS allowed_actions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS action_prompt text,
  ADD COLUMN IF NOT EXISTS last_action_request_id text;

CREATE INDEX IF NOT EXISTS wallet_wagers_active_game_idx
  ON wallet_wager_reservations(thread_key, requested_by_user_id, updated_at DESC)
  WHERE status = 'drawn' AND awaiting_action = true;
