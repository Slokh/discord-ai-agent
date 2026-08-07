-- Current process liveness is a bounded projection, not a second event ledger.
-- Runtime and improvement history remain in their canonical tables.
CREATE TABLE service_runtime_heartbeats (
  component text NOT NULL CHECK (component IN ('bot', 'worker', 'api', 'console')),
  instance_id text NOT NULL,
  revision text NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (component, instance_id)
);

CREATE INDEX service_runtime_heartbeats_component_seen_idx
  ON service_runtime_heartbeats(component, last_seen_at DESC);
