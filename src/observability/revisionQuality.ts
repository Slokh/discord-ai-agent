import type { DbPool } from "../db/pool.js";

export type RevisionQuality = {
  revision: string;
  windowHours: number;
  generatedAt: string;
  answers: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  deliveries: Record<string, unknown>[];
};

/** Returns content-free production quality aggregates from the canonical runtime ledger. */
export async function collectRevisionQuality(
  pool: DbPool,
  revision: string,
  hours: number,
): Promise<RevisionQuality> {
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
      `SELECT obligation.state, count(*)::int AS count
       FROM discord_delivery_obligations obligation
       JOIN agent_runtime_executions execution ON execution.execution_id = obligation.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE obligation.created_at >= now() - ($1::text || ' hours')::interval
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY obligation.state
       ORDER BY obligation.state`,
      [hours, revision],
    ),
  ]);

  return {
    revision,
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    answers: answers.rows,
    tools: tools.rows,
    signals: signals.rows,
    deliveries: deliveries.rows,
  };
}
