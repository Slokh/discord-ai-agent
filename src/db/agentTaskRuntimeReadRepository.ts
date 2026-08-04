import type { DbPool } from "./pool.js";
import {
  AGENT_RUNTIME_CHAT_EXECUTION_COLUMNS,
  AGENT_RUNTIME_CHAT_EXECUTION_JOINS,
  rowToAgentRuntimeChatExecution,
  rowToTaskEvent,
} from "./shared.js";
import type { AgentRuntimeChatExecution, TaskEvent } from "./shared.js";

/** Reads the runtime ledger used by code-update task rendering and bug repair. */
export async function findAgentRuntimeChatExecutionByTraceId(
  pool: DbPool,
  traceId: string,
): Promise<AgentRuntimeChatExecution | undefined> {
  const result = await pool.query(
    `
      SELECT ${AGENT_RUNTIME_CHAT_EXECUTION_COLUMNS}
      FROM agent_runtime_executions cex
      JOIN agent_runtime_sessions cs ON cs.session_id = cex.session_id
      ${AGENT_RUNTIME_CHAT_EXECUTION_JOINS}
      WHERE cex.task_id IS NULL
        AND cs.metadata->>'kind' = 'discord_channel'
        AND (
          cex.trace_id = $1
          OR cex.metadata->>'discordMessageId' = $1
          OR cex.metadata->>'promptMessageId' = $1
          OR cex.metadata->>'replyMessageId' = $1
          OR cex.metadata->>'replyUrl' LIKE '%' || $1
        )
      ORDER BY cex.updated_at DESC
      LIMIT 1
    `,
    [traceId],
  );
  return result.rows[0] ? rowToAgentRuntimeChatExecution(result.rows[0]) : undefined;
}

export async function getAgentRuntimeTaskEventsForTask(
  pool: DbPool,
  input: { taskId: string; limit?: number },
): Promise<TaskEvent[]> {
  const limit = Math.max(1, Math.min(300, Math.trunc(input.limit ?? 200)));
  const result = await pool.query(
    `
      SELECT *
      FROM (
        SELECT
          ce.id,
          coalesce(ce.metadata->>'taskId', cex.task_id, $1) AS task_id,
          ce.trace_id,
          ce.event_name,
          ce.level,
          ce.summary,
          ce.metadata,
          ce.created_at
        FROM agent_runtime_events ce
        JOIN agent_runtime_executions cex ON cex.execution_id = ce.execution_id
        WHERE cex.execution_id = 'agent-task-execution-' || $1
          AND cex.metadata->>'runtime' = 'agent'
          AND ce.event_name LIKE 'agent.task.%'
        ORDER BY ce.created_at DESC, ce.id DESC
        LIMIT $2
      ) recent
      ORDER BY created_at ASC, id ASC
    `,
    [input.taskId, limit],
  );
  return result.rows.map(rowToTaskEvent);
}

export async function getAgentTaskMetrics(pool: DbPool): Promise<{
  tasksByStatus: Array<{ status: string; count: number }>;
  agentTaskBacklog: Array<{ backend: string; status: string; count: number; oldestAgeSeconds: number }>;
  sandboxRunsByStatus: Array<{ status: string; count: number }>;
  taskPhaseDurations: Array<{ phase: string; count: number; avgMs: number; maxMs: number }>;
}> {
  const [tasks, taskBacklog, sandboxRuns, phaseDurations] = await Promise.all([
    pool.query("SELECT status, count(*)::int AS count FROM agent_tasks GROUP BY status ORDER BY status"),
    pool.query(`
      SELECT coalesce(nullif(backend, ''), 'unknown') AS backend, status, count(*)::int AS count,
        floor(extract(epoch FROM now() - min(coalesce(started_at, created_at))))::int AS oldest_age_seconds
      FROM agent_tasks WHERE status IN ('queued', 'running') GROUP BY backend, status ORDER BY backend, status
    `),
    pool.query("SELECT status, count(*)::int AS count FROM sandbox_runs GROUP BY status ORDER BY status"),
    pool.query(`
      SELECT regexp_replace(metadata->>'step', '_complete$', '') AS phase, count(*)::int AS count,
        round(avg((metadata->>'durationMs')::numeric))::int AS avg_ms,
        max((metadata->>'durationMs')::numeric)::int AS max_ms
      FROM agent_runtime_events
      WHERE event_name = 'agent.task.progress' AND metadata ? 'durationMs' AND (metadata->>'step') ~ '_complete$'
      GROUP BY phase ORDER BY phase
    `),
  ]);
  return {
    tasksByStatus: tasks.rows.map((row) => ({ status: String(row.status), count: Number(row.count) })),
    agentTaskBacklog: taskBacklog.rows.map((row) => ({
      backend: String(row.backend), status: String(row.status), count: Number(row.count), oldestAgeSeconds: Number(row.oldest_age_seconds),
    })),
    sandboxRunsByStatus: sandboxRuns.rows.map((row) => ({ status: String(row.status), count: Number(row.count) })),
    taskPhaseDurations: phaseDurations.rows.map((row) => ({
      phase: String(row.phase), count: Number(row.count), avgMs: Number(row.avg_ms), maxMs: Number(row.max_ms),
    })),
  };
}
