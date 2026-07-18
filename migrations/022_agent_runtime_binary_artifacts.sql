CREATE TABLE IF NOT EXISTS agent_runtime_artifact_blobs (
  artifact_id text PRIMARY KEY REFERENCES agent_runtime_artifacts(artifact_id) ON DELETE CASCADE,
  content bytea NOT NULL
);
