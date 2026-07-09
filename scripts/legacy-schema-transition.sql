-- One-time transition for databases that were created from the old 001-009
-- migration chain before the pre-1.0 migration squash.
--
-- Fresh installs that start from the squashed migrations/001_initial.sql never
-- need this script. Run it once on an existing legacy database after deploying
-- the squashed migration set; it renames runtime tables/objects, removes dead
-- tables, and leaves schema_migrations with only the new baseline version.

BEGIN;

DROP TABLE IF EXISTS task_events CASCADE;
DROP TABLE IF EXISTS durable_workflows CASCADE;

ALTER TABLE IF EXISTS codegen_sessions RENAME TO agent_runtime_sessions;
ALTER TABLE IF EXISTS codegen_executions RENAME TO agent_runtime_executions;
ALTER TABLE IF EXISTS codegen_events RENAME TO agent_runtime_events;
ALTER TABLE IF EXISTS codegen_messages RENAME TO agent_runtime_messages;
ALTER TABLE IF EXISTS codegen_artifacts RENAME TO agent_runtime_artifacts;
ALTER TABLE IF EXISTS codegen_artifact_chunks RENAME TO agent_runtime_artifact_chunks;
ALTER TABLE IF EXISTS codegen_sandbox_leases RENAME TO agent_runtime_sandbox_leases;

ALTER TABLE IF EXISTS agent_runtime_sessions RENAME COLUMN codex_thread_id TO harness_thread_id;

DO $$
BEGIN
  IF to_regclass('public.codegen_sessions_trace_idx') IS NOT NULL THEN
    ALTER INDEX codegen_sessions_trace_idx RENAME TO agent_runtime_sessions_trace_idx;
  END IF;
  IF to_regclass('public.codegen_sessions_thread_updated_idx') IS NOT NULL THEN
    ALTER INDEX codegen_sessions_thread_updated_idx RENAME TO agent_runtime_sessions_thread_updated_idx;
  END IF;
  IF to_regclass('public.codegen_sessions_status_updated_idx') IS NOT NULL THEN
    ALTER INDEX codegen_sessions_status_updated_idx RENAME TO agent_runtime_sessions_status_updated_idx;
  END IF;
  IF to_regclass('public.codegen_executions_session_attempt_idx') IS NOT NULL THEN
    ALTER INDEX codegen_executions_session_attempt_idx RENAME TO agent_runtime_executions_session_attempt_idx;
  END IF;
  IF to_regclass('public.codegen_executions_task_idx') IS NOT NULL THEN
    ALTER INDEX codegen_executions_task_idx RENAME TO agent_runtime_executions_task_idx;
  END IF;
  IF to_regclass('public.codegen_executions_status_updated_idx') IS NOT NULL THEN
    ALTER INDEX codegen_executions_status_updated_idx RENAME TO agent_runtime_executions_status_updated_idx;
  END IF;
  IF to_regclass('public.codegen_events_execution_sequence_idx') IS NOT NULL THEN
    ALTER INDEX codegen_events_execution_sequence_idx RENAME TO agent_runtime_events_execution_sequence_idx;
  END IF;
  IF to_regclass('public.codegen_events_session_created_idx') IS NOT NULL THEN
    ALTER INDEX codegen_events_session_created_idx RENAME TO agent_runtime_events_session_created_idx;
  END IF;
  IF to_regclass('public.codegen_events_created_idx') IS NOT NULL THEN
    ALTER INDEX codegen_events_created_idx RENAME TO agent_runtime_events_created_idx;
  END IF;
  IF to_regclass('public.codegen_messages_session_client_message_idx') IS NOT NULL THEN
    ALTER INDEX codegen_messages_session_client_message_idx RENAME TO agent_runtime_messages_session_client_message_idx;
  END IF;
  IF to_regclass('public.codegen_messages_session_created_idx') IS NOT NULL THEN
    ALTER INDEX codegen_messages_session_created_idx RENAME TO agent_runtime_messages_session_created_idx;
  END IF;
  IF to_regclass('public.codegen_artifacts_execution_created_idx') IS NOT NULL THEN
    ALTER INDEX codegen_artifacts_execution_created_idx RENAME TO agent_runtime_artifacts_execution_created_idx;
  END IF;
  IF to_regclass('public.codegen_artifacts_session_created_idx') IS NOT NULL THEN
    ALTER INDEX codegen_artifacts_session_created_idx RENAME TO agent_runtime_artifacts_session_created_idx;
  END IF;
  IF to_regclass('public.codegen_sandbox_leases_repo_status_idx') IS NOT NULL THEN
    ALTER INDEX codegen_sandbox_leases_repo_status_idx RENAME TO agent_runtime_sandbox_leases_repo_status_idx;
  END IF;

  IF to_regclass('public.codegen_sessions_pkey') IS NOT NULL THEN
    ALTER INDEX codegen_sessions_pkey RENAME TO agent_runtime_sessions_pkey;
  END IF;
  IF to_regclass('public.codegen_executions_pkey') IS NOT NULL THEN
    ALTER INDEX codegen_executions_pkey RENAME TO agent_runtime_executions_pkey;
  END IF;
  IF to_regclass('public.codegen_events_pkey') IS NOT NULL THEN
    ALTER INDEX codegen_events_pkey RENAME TO agent_runtime_events_pkey;
  END IF;
  IF to_regclass('public.codegen_events_id_seq') IS NOT NULL THEN
    ALTER SEQUENCE codegen_events_id_seq RENAME TO agent_runtime_events_id_seq;
  END IF;
  IF to_regclass('public.codegen_events_execution_id_sequence_key') IS NOT NULL THEN
    ALTER INDEX codegen_events_execution_id_sequence_key RENAME TO agent_runtime_events_execution_id_sequence_key;
  END IF;
  IF to_regclass('public.codegen_messages_pkey') IS NOT NULL THEN
    ALTER INDEX codegen_messages_pkey RENAME TO agent_runtime_messages_pkey;
  END IF;
  IF to_regclass('public.codegen_artifacts_pkey') IS NOT NULL THEN
    ALTER INDEX codegen_artifacts_pkey RENAME TO agent_runtime_artifacts_pkey;
  END IF;
  IF to_regclass('public.codegen_artifact_chunks_pkey') IS NOT NULL THEN
    ALTER INDEX codegen_artifact_chunks_pkey RENAME TO agent_runtime_artifact_chunks_pkey;
  END IF;
  IF to_regclass('public.codegen_sandbox_leases_pkey') IS NOT NULL THEN
    ALTER INDEX codegen_sandbox_leases_pkey RENAME TO agent_runtime_sandbox_leases_pkey;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_executions_session_id_fkey') THEN
    ALTER TABLE agent_runtime_executions RENAME CONSTRAINT codegen_executions_session_id_fkey TO agent_runtime_executions_session_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_executions_task_id_fkey') THEN
    ALTER TABLE agent_runtime_executions RENAME CONSTRAINT codegen_executions_task_id_fkey TO agent_runtime_executions_task_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_events_session_id_fkey') THEN
    ALTER TABLE agent_runtime_events RENAME CONSTRAINT codegen_events_session_id_fkey TO agent_runtime_events_session_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_events_execution_id_fkey') THEN
    ALTER TABLE agent_runtime_events RENAME CONSTRAINT codegen_events_execution_id_fkey TO agent_runtime_events_execution_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_events_execution_id_sequence_key') THEN
    ALTER TABLE agent_runtime_events RENAME CONSTRAINT codegen_events_execution_id_sequence_key TO agent_runtime_events_execution_id_sequence_key;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_messages_session_id_fkey') THEN
    ALTER TABLE agent_runtime_messages RENAME CONSTRAINT codegen_messages_session_id_fkey TO agent_runtime_messages_session_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_messages_role_supported') THEN
    ALTER TABLE agent_runtime_messages RENAME CONSTRAINT codegen_messages_role_supported TO agent_runtime_messages_role_supported;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_artifacts_session_id_fkey') THEN
    ALTER TABLE agent_runtime_artifacts RENAME CONSTRAINT codegen_artifacts_session_id_fkey TO agent_runtime_artifacts_session_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_artifacts_execution_id_fkey') THEN
    ALTER TABLE agent_runtime_artifacts RENAME CONSTRAINT codegen_artifacts_execution_id_fkey TO agent_runtime_artifacts_execution_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_artifact_chunks_artifact_id_fkey') THEN
    ALTER TABLE agent_runtime_artifact_chunks RENAME CONSTRAINT codegen_artifact_chunks_artifact_id_fkey TO agent_runtime_artifact_chunks_artifact_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codegen_sandbox_leases_execution_id_fkey') THEN
    ALTER TABLE agent_runtime_sandbox_leases RENAME CONSTRAINT codegen_sandbox_leases_execution_id_fkey TO agent_runtime_sandbox_leases_execution_id_fkey;
  END IF;
END $$;

-- Catch-up: objects that exist in the squashed baseline but were never part of
-- the legacy 001-007 chain. Everything here is idempotent, so databases that
-- already have them are unaffected.

CREATE TABLE IF NOT EXISTS conversation_snapshots (
  snapshot_id bigserial PRIMARY KEY,
  thread_key text NOT NULL REFERENCES conversation_sessions(thread_key) ON DELETE CASCADE,
  summary text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  from_message_id bigint,
  to_message_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_snapshots_thread_created_idx
  ON conversation_snapshots(thread_key, created_at DESC, snapshot_id DESC);

CREATE TABLE IF NOT EXISTS discord_delivery_obligations (
  execution_id text PRIMARY KEY,
  thread_key text,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  status_channel_id text,
  status_message_id text,
  source_message_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS discord_delivery_obligations_pending_idx
  ON discord_delivery_obligations(updated_at ASC, created_at ASC)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS messages_embedding_backlog_live_idx
  ON messages(guild_id, created_at DESC, id)
  WHERE deleted_at IS NULL
    AND normalized_content <> '';

CREATE INDEX IF NOT EXISTS conversation_messages_thread_id_idx
  ON conversation_messages(thread_key, id);

CREATE INDEX IF NOT EXISTS tool_audit_logs_guild_created_idx
  ON tool_audit_logs(guild_id, created_at DESC)
  WHERE guild_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_tasks_updated_created_idx
  ON agent_tasks(updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_tasks_stale_running_idx
  ON agent_tasks((coalesce(progress_updated_at, updated_at, started_at, created_at)), created_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS agent_tasks_live_message_backlog_idx
  ON agent_tasks(coalesce(progress_updated_at, updated_at) DESC, created_at DESC)
  WHERE status IN ('queued', 'running')
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_tasks_terminal_notification_idx
  ON agent_tasks(updated_at DESC, created_at DESC)
  WHERE status IN ('succeeded', 'failed', 'cancelled')
    AND notified_at IS NULL
    AND discord_response_channel_id IS NOT NULL
    AND discord_response_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sandbox_command_events_created_idx
  ON sandbox_command_events(created_at, id);

CREATE INDEX IF NOT EXISTS process_run_artifacts_expires_idx
  ON process_run_artifacts(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runtime_events_created_idx
  ON agent_runtime_events(created_at, id);

DELETE FROM schema_migrations WHERE version <> '001_initial';

COMMIT;
