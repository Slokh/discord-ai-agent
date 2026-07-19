ALTER TABLE discord_component_actions
  ADD COLUMN IF NOT EXISTS generation_id text,
  ADD COLUMN IF NOT EXISTS action_schema_version smallint NOT NULL DEFAULT 1;

UPDATE discord_component_actions
   SET generation_id = 'legacy:' || token_hash
 WHERE generation_id IS NULL;

ALTER TABLE discord_component_actions
  ALTER COLUMN generation_id SET NOT NULL,
  ALTER COLUMN state SET DEFAULT 'pending';

ALTER TABLE discord_component_actions
  DROP CONSTRAINT IF EXISTS discord_component_actions_state_check;

ALTER TABLE discord_component_actions
  ADD CONSTRAINT discord_component_actions_state_check
  CHECK (state IN ('pending', 'active', 'consumed', 'expired', 'cancelled'));

CREATE INDEX IF NOT EXISTS discord_component_actions_generation_idx
  ON discord_component_actions(generation_id);
