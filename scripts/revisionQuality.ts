import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";

const config = loadConfig();
const revision = argument("--revision") ?? config.appRevision;
const hours = boundedNumber(argument("--hours") ?? "48", 1, 168);
const pool = createPool(config);

try {
  const [answers, tools, signals, deliveries] = await Promise.all([
    pool.query(
      `SELECT coalesce(nullif(e.model, ''), 'unknown') AS model,
              e.status,
              count(*)::int AS count,
              round(coalesce(percentile_cont(0.95) WITHIN GROUP (
                ORDER BY extract(epoch FROM (e.completed_at - e.started_at)) * 1000
              ) FILTER (WHERE e.started_at IS NOT NULL AND e.completed_at IS NOT NULL), 0))::int AS p95_ms
       FROM agent_runtime_executions e
       JOIN agent_runtime_sessions s ON s.session_id = e.session_id
       WHERE e.created_at >= now() - ($1::text || ' hours')::interval
         AND e.task_id IS NULL
         AND e.harness = 'nanocodex'
         AND coalesce(nullif(e.metadata->>'appRevision', ''), nullif(s.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY 1, e.status
       ORDER BY 1, e.status`,
      [hours, revision],
    ),
    pool.query(
      `SELECT coalesce(event.metadata->>'toolName', 'unknown') AS tool,
              coalesce(event.metadata->>'status', 'ok') AS status,
              count(*)::int AS count
       FROM agent_runtime_events event
       JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE event.created_at >= now() - ($1::text || ' hours')::interval
         AND event.event_name = 'agent.tool.complete'
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      [hours, revision],
    ),
    pool.query(
      `SELECT event.level, count(*)::int AS count
       FROM agent_runtime_events event
       JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE event.created_at >= now() - ($1::text || ' hours')::interval
         AND event.level IN ('warn', 'error')
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY event.level
       ORDER BY event.level`,
      [hours, revision],
    ),
    pool.query(
      `SELECT obligation.status, count(*)::int AS count
       FROM discord_delivery_obligations obligation
       JOIN agent_runtime_executions execution ON execution.execution_id = obligation.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE obligation.created_at >= now() - ($1::text || ' hours')::interval
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY obligation.status
       ORDER BY obligation.status`,
      [hours, revision],
    ),
  ]);

  process.stdout.write(`${JSON.stringify({
    revision,
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    answers: answers.rows,
    tools: tools.rows,
    signals: signals.rows,
    deliveries: deliveries.rows,
  }, null, 2)}\n`);
} finally {
  await pool.end();
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedNumber(value: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}.`);
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
