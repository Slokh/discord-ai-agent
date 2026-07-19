DROP INDEX IF EXISTS discord_component_actions_expiry_idx;

CREATE INDEX discord_component_actions_expiry_idx
  ON discord_component_actions(expires_at)
  WHERE state IN ('pending', 'active');
