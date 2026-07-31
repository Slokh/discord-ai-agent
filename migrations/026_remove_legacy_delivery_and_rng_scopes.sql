CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Delivery intents used to embed files as base64. Materialize those files as
-- normal binary artifacts and rewrite each intent to the only supported schema.
WITH legacy_intents AS (
  SELECT
    artifact.artifact_id,
    artifact.session_id,
    artifact.execution_id,
    artifact.expires_at,
    artifact.metadata,
    string_agg(chunk.content, '' ORDER BY chunk.chunk_index)::jsonb AS intent
  FROM agent_runtime_artifacts artifact
  JOIN agent_runtime_artifact_chunks chunk USING (artifact_id)
  WHERE artifact.kind = 'discord_delivery_intent'
  GROUP BY artifact.artifact_id, artifact.session_id, artifact.execution_id, artifact.expires_at, artifact.metadata
  HAVING (string_agg(chunk.content, '' ORDER BY chunk.chunk_index)::jsonb ->> 'schemaVersion') = '1'
), legacy_files AS (
  SELECT
    intent.*,
    file.value AS file,
    file.ordinality AS ordinal,
    intent.artifact_id || ':delivery-file:' || file.ordinality AS file_artifact_id
  FROM legacy_intents intent
  CROSS JOIN LATERAL jsonb_array_elements(intent.intent -> 'files') WITH ORDINALITY AS file(value, ordinality)
), inserted_files AS (
  INSERT INTO agent_runtime_artifacts(
    artifact_id, session_id, execution_id, kind, name, content_type,
    size_bytes, preview, redacted, expires_at, metadata
  )
  SELECT
    file_artifact_id,
    session_id,
    execution_id,
    'discord_delivery_file',
    file ->> 'name',
    coalesce(file ->> 'contentType', 'application/octet-stream'),
    octet_length(decode(file ->> 'dataBase64', 'base64')),
    '[migrated binary delivery file]',
    false,
    expires_at,
    jsonb_build_object(
      'deliveryFile', true,
      'binary', true,
      'sha256', encode(digest(decode(file ->> 'dataBase64', 'base64'), 'sha256'), 'hex'),
      'migratedFromDeliveryIntent', artifact_id
    )
  FROM legacy_files
  ON CONFLICT (artifact_id) DO NOTHING
  RETURNING artifact_id
), inserted_blobs AS (
  INSERT INTO agent_runtime_artifact_blobs(artifact_id, content)
  SELECT file.file_artifact_id, decode(file.file ->> 'dataBase64', 'base64')
  FROM legacy_files file
  JOIN inserted_files inserted ON inserted.artifact_id = file.file_artifact_id
  ON CONFLICT (artifact_id) DO NOTHING
  RETURNING artifact_id
), rewritten_intents AS (
  SELECT
    intent.artifact_id,
    jsonb_set(
      jsonb_set(intent.intent, '{schemaVersion}', '2'::jsonb, true),
      '{files}',
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'artifactId', file.file_artifact_id,
            'name', file.file ->> 'name',
            'contentType', file.file ->> 'contentType',
            'sizeBytes', octet_length(decode(file.file ->> 'dataBase64', 'base64')),
            'sha256', encode(digest(decode(file.file ->> 'dataBase64', 'base64'), 'sha256'), 'hex')
          )
          ORDER BY file.ordinal
        ) FILTER (WHERE file.file_artifact_id IS NOT NULL),
        '[]'::jsonb
      ),
      true
    )::text AS content
  FROM legacy_intents intent
  LEFT JOIN legacy_files file ON file.artifact_id = intent.artifact_id
  CROSS JOIN (SELECT count(*) FROM inserted_blobs) AS blobs
  GROUP BY intent.artifact_id, intent.intent
), updated_intents AS (
  UPDATE agent_runtime_artifacts artifact
  SET
    size_bytes = octet_length(rewritten.content),
    preview = left(rewritten.content, 2000),
    metadata = jsonb_set(artifact.metadata, '{schemaVersion}', '2'::jsonb, true)
  FROM rewritten_intents rewritten
  WHERE artifact.artifact_id = rewritten.artifact_id
  RETURNING artifact.artifact_id, rewritten.content
), upserted_chunks AS (
  INSERT INTO agent_runtime_artifact_chunks(artifact_id, chunk_index, content)
  SELECT artifact_id, 0, content
  FROM updated_intents
  ON CONFLICT (artifact_id, chunk_index) DO UPDATE
  SET content = EXCLUDED.content
  RETURNING artifact_id
)
DELETE FROM agent_runtime_artifact_chunks extra
USING upserted_chunks written
WHERE extra.artifact_id = written.artifact_id
  AND extra.chunk_index > 0;

-- Turn envelopes are replayed only in their current schema. The v1 shape is
-- otherwise structurally compatible, so upgrading its version is lossless.
WITH legacy_envelopes AS (
  SELECT
    artifact.artifact_id,
    string_agg(chunk.content, '' ORDER BY chunk.chunk_index)::jsonb AS envelope
  FROM agent_runtime_artifacts artifact
  JOIN agent_runtime_artifact_chunks chunk USING (artifact_id)
  WHERE artifact.kind = 'turn_envelope'
  GROUP BY artifact.artifact_id
  HAVING (string_agg(chunk.content, '' ORDER BY chunk.chunk_index)::jsonb ->> 'schemaVersion') = '1'
), updated_envelopes AS (
  UPDATE agent_runtime_artifacts artifact
  SET
    size_bytes = octet_length(jsonb_set(envelope.envelope, '{schemaVersion}', '2'::jsonb, true)::text),
    preview = left(jsonb_set(envelope.envelope, '{schemaVersion}', '2'::jsonb, true)::text, 2000),
    metadata = jsonb_set(artifact.metadata, '{schemaVersion}', '2'::jsonb, true)
  FROM legacy_envelopes envelope
  WHERE artifact.artifact_id = envelope.artifact_id
  RETURNING artifact.artifact_id, jsonb_set(envelope.envelope, '{schemaVersion}', '2'::jsonb, true)::text AS content
), upserted_envelope_chunks AS (
  INSERT INTO agent_runtime_artifact_chunks(artifact_id, chunk_index, content)
  SELECT artifact_id, 0, content
  FROM updated_envelopes
  ON CONFLICT (artifact_id, chunk_index) DO UPDATE
  SET content = EXCLUDED.content
  RETURNING artifact_id
)
DELETE FROM agent_runtime_artifact_chunks extra
USING upserted_envelope_chunks written
WHERE extra.artifact_id = written.artifact_id
  AND extra.chunk_index > 0;

-- Legacy RNG sessions were channel-scoped. Sessions with a recorded source
-- message become reply-root scoped; empty sessions are safely revealed because
-- they consumed no entropy and cannot be meaningfully resumed.
WITH first_draw AS (
  SELECT DISTINCT ON (session_id)
    session_id,
    message_id
  FROM rng_draws
  WHERE message_id IS NOT NULL AND message_id <> ''
  ORDER BY session_id, id ASC
)
UPDATE rng_sessions session
SET thread_key = session.thread_key || ':rng-root:' || draw.message_id
FROM first_draw draw
WHERE session.id = draw.session_id
  AND session.status = 'active'
  AND strpos(session.thread_key, ':rng-root:') = 0;

UPDATE rng_sessions
SET status = 'revealed', revealed_at = coalesce(revealed_at, now())
WHERE status = 'active'
  AND strpos(thread_key, ':rng-root:') = 0;
