-- agent_runtime_* is the sole execution ledger. These retired tables have no
-- writers or readers and are deliberately purged rather than archived.
DROP TABLE IF EXISTS process_run_artifact_chunks;
DROP TABLE IF EXISTS process_run_artifacts;
DROP TABLE IF EXISTS process_run_events;
DROP TABLE IF EXISTS process_run_spans;
DROP TABLE IF EXISTS process_runs;
DROP TABLE IF EXISTS sandbox_command_events;
DROP TABLE IF EXISTS trace_events;
