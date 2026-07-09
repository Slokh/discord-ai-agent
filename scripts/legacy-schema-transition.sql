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

DELETE FROM schema_migrations WHERE version <> '001_initial';

COMMIT;
