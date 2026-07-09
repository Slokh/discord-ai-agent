import type { DbPool } from "./pool.js";
import { rowToAgentRuntimeEvent, AGENT_RUNTIME_CHAT_EXECUTION_COLUMNS, rowToAgentRuntimeChatExecution, rowToAgentRuntimeArtifact, rowToAgentRuntimeMessage, rowToTaskEvent } from "./shared.js";
import type { TaskEvent, AgentRuntimeEvent, AgentRuntimeMessage, AgentRuntimeChatExecution, AgentRuntimeArtifactRecord, AgentRuntimeArtifactContent } from "./shared.js";

export async function getAgentRuntimeEventsForTrace(pool: DbPool, input: { traceId: string; limit?: number }): Promise<AgentRuntimeEvent[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 200)));
    const result = await pool.query(
      `
        SELECT
          ce.id,
          ce.session_id,
          ce.execution_id,
          coalesce(ce.trace_id, cex.trace_id) AS trace_id,
          ce.kind,
          ce.level,
          ce.event_name,
          ce.summary,
          ce.metadata,
          ce.duration_ms,
          ce.created_at
        FROM codegen_events ce
        JOIN codegen_sessions cs ON cs.session_id = ce.session_id
        LEFT JOIN codegen_executions cex ON cex.execution_id = ce.execution_id
        WHERE (
            ce.trace_id = $1
            OR cex.trace_id = $1
            OR ce.metadata->>'traceId' = $1
            OR ce.metadata->>'promptMessageId' = $1
            OR ce.metadata->>'discordMessageId' = $1
            OR ce.metadata->>'messageId' = $1
            OR ce.metadata->>'runId' = $1
            OR ce.metadata->>'executionId' IN (
              SELECT execution_id
              FROM codegen_executions
              WHERE trace_id = $1
                 OR metadata->>'parentAgentExecutionId' = (
                   SELECT metadata->>'agentExecutionId'
                   FROM process_runs
                   WHERE trace_id = $1 OR run_id = $1
                   ORDER BY updated_at DESC
                   LIMIT 1
                 )
            )
          )
          AND (
            ce.metadata->>'runtime' = 'agent'
            OR cex.metadata->>'runtime' = 'agent'
            OR cs.metadata->>'runtime' = 'agent'
          )
          AND ce.event_name NOT LIKE 'agent.task.%'
        ORDER BY ce.created_at ASC, ce.id ASC
        LIMIT $2
      `,
      [input.traceId, limit]
    );
    return result.rows.map(rowToAgentRuntimeEvent);
  }



export async function getAgentRuntimeMessagesForTrace(pool: DbPool, input: { traceId: string; limit?: number }): Promise<AgentRuntimeMessage[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    const clientMessagePrefix = `${input.traceId}:transcript:%`;
    const result = await pool.query(
      `
        SELECT
          cm.message_id,
          cm.session_id,
          cm.client_message_id,
          cm.role,
          cm.parts,
          cm.metadata,
          cm.created_at
        FROM codegen_messages cm
        JOIN codegen_sessions cs ON cs.session_id = cm.session_id
        WHERE cs.metadata->>'runtime' = 'agent'
          AND (
            cm.client_message_id = $1
            OR cm.client_message_id LIKE $2
            OR cm.metadata->>'traceId' = $1
            OR cm.metadata->>'promptMessageId' = $1
            OR cm.metadata->>'executionId' IN (
              SELECT execution_id
              FROM codegen_executions
              WHERE trace_id = $1
                 OR metadata->>'parentAgentExecutionId' = (
                   SELECT metadata->>'agentExecutionId'
                   FROM process_runs
                   WHERE trace_id = $1 OR run_id = $1
                   ORDER BY updated_at DESC
                   LIMIT 1
                 )
            )
            OR cm.metadata->>'taskId' IN (
              SELECT task_id
              FROM agent_tasks
              WHERE trace_id = $1 OR task_id = $1
            )
            OR cm.client_message_id IN (
              SELECT metadata->>'replyMessageId'
              FROM codegen_executions
              WHERE trace_id = $1
                AND metadata->>'replyMessageId' IS NOT NULL
            )
          )
        ORDER BY cm.created_at ASC, cm.message_id ASC
        LIMIT $3
      `,
      [input.traceId, clientMessagePrefix, limit]
    );
    return result.rows.map(rowToAgentRuntimeMessage);
  }



export async function listAgentRuntimeChatExecutions(pool: DbPool, input: { limit?: number } = {}): Promise<AgentRuntimeChatExecution[]> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const result = await pool.query(
      `
        SELECT ${AGENT_RUNTIME_CHAT_EXECUTION_COLUMNS}
        FROM codegen_executions cex
        JOIN codegen_sessions cs ON cs.session_id = cex.session_id
        WHERE cex.task_id IS NULL
          AND cs.metadata->>'kind' = 'discord_channel'
        ORDER BY cex.updated_at DESC
        LIMIT $1
      `,
      [limit]
    );
    return result.rows.map(rowToAgentRuntimeChatExecution);
  }



export async function findAgentRuntimeChatExecutionByTraceId(pool: DbPool, traceId: string): Promise<AgentRuntimeChatExecution | undefined> {
    const result = await pool.query(
      `
        SELECT ${AGENT_RUNTIME_CHAT_EXECUTION_COLUMNS}
        FROM codegen_executions cex
        JOIN codegen_sessions cs ON cs.session_id = cex.session_id
        WHERE cex.task_id IS NULL
          AND cs.metadata->>'kind' = 'discord_channel'
          AND (
            cex.trace_id = $1
            OR cex.metadata->>'discordMessageId' = $1
            OR cex.metadata->>'promptMessageId' = $1
          )
        ORDER BY cex.updated_at DESC
        LIMIT 1
      `,
      [traceId]
    );
    const row = result.rows[0];
    return row ? rowToAgentRuntimeChatExecution(row) : undefined;
  }



export async function getAgentRuntimeArtifactsForExecution(pool: DbPool, input: { executionId: string; sessionId: string }): Promise<AgentRuntimeArtifactRecord[]> {
    const result = await pool.query(
      `
        SELECT artifact_id, session_id, execution_id, kind, name, content_type, size_bytes, preview, redacted, expires_at, metadata, created_at
        FROM codegen_artifacts
        WHERE execution_id = $1
           OR (session_id = $2 AND execution_id IS NULL)
        ORDER BY created_at ASC, artifact_id ASC
      `,
      [input.executionId, input.sessionId]
    );
    return result.rows.map(rowToAgentRuntimeArtifact);
  }



export async function getAgentRuntimeArtifact(pool: DbPool, input: { artifactId: string }): Promise<AgentRuntimeArtifactContent | undefined> {
    const [artifact, chunks] = await Promise.all([
      pool.query(
        `SELECT artifact_id, session_id, execution_id, kind, name, content_type, size_bytes, preview, redacted, expires_at, metadata, created_at
         FROM codegen_artifacts WHERE artifact_id = $1`,
        [input.artifactId]
      ),
      pool.query("SELECT content FROM codegen_artifact_chunks WHERE artifact_id = $1 ORDER BY chunk_index ASC", [input.artifactId])
    ]);
    const row = artifact.rows[0];
    if (!row) return undefined;
    return {
      ...rowToAgentRuntimeArtifact(row),
      content: chunks.rows.map((chunk) => String(chunk.content ?? "")).join("")
    };
  }



export async function getTaskEventsForTask(pool: DbPool, input: { taskId: string; limit?: number }): Promise<TaskEvent[]> {
    const limit = Math.max(1, Math.min(300, Math.trunc(input.limit ?? 200)));
    const result = await pool.query(
      `
        SELECT *
        FROM (
          SELECT
            id, task_id, trace_id, event_name, level,
            summary, metadata, created_at
          FROM task_events
          WHERE task_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2
        ) recent
        ORDER BY created_at ASC, id ASC
      `,
      [input.taskId, limit]
    );
    return result.rows.map(rowToTaskEvent);
  }



export async function getAgentRuntimeTaskEventsForTask(pool: DbPool, input: { taskId: string; limit?: number }): Promise<TaskEvent[]> {
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
          FROM codegen_events ce
          JOIN codegen_executions cex ON cex.execution_id = ce.execution_id
          WHERE cex.task_id = $1
            AND cex.metadata->>'runtime' = 'agent'
            AND ce.event_name LIKE 'agent.task.%'
          ORDER BY ce.created_at DESC, ce.id DESC
          LIMIT $2
        ) recent
        ORDER BY created_at ASC, id ASC
      `,
      [input.taskId, limit]
    );
    return result.rows.map(rowToTaskEvent);
  }



export async function getTaskProgressEventsForTask(pool: DbPool, input: { taskId: string; limit?: number }): Promise<TaskEvent[]> {
    const runtimeEvents = await getAgentRuntimeTaskEventsForTask(pool, input);
    if (runtimeEvents.length > 0) return runtimeEvents;
    return getTaskEventsForTask(pool, input);
  }



export async function getAgentTaskMetrics(pool: DbPool, ): Promise<{
    tasksByStatus: Array<{ status: string; count: number }>;
    agentTaskBacklog: Array<{ backend: string; status: string; count: number; oldestAgeSeconds: number }>;
    sandboxRunsByStatus: Array<{ status: string; count: number }>;
    codegenSandboxLeases: Array<{ backend: string; status: string; count: number }>;
    codegenPhaseDurations: Array<{ phase: string; count: number; avgMs: number; maxMs: number }>;
    sandboxCacheEvents: Array<{ cacheType: string; cacheStatus: string; count: number }>;
  }> {
    const [tasks, taskBacklog, sandboxRuns, codegenSandboxLeases, phaseDurations, cacheEvents] = await Promise.all([
      pool.query("SELECT status, count(*)::int AS count FROM agent_tasks GROUP BY status ORDER BY status"),
      pool.query(`
        SELECT
          coalesce(nullif(backend, ''), 'unknown') AS backend,
          status,
          count(*)::int AS count,
          floor(extract(epoch FROM now() - min(coalesce(started_at, created_at))))::int AS oldest_age_seconds
        FROM agent_tasks
        WHERE status IN ('queued', 'running')
        GROUP BY backend, status
        ORDER BY backend, status
      `),
      pool.query("SELECT status, count(*)::int AS count FROM sandbox_runs GROUP BY status ORDER BY status"),
      pool.query(`
        SELECT
          coalesce(nullif(metadata->>'backend', ''), 'unknown') AS backend,
          status,
          count(*)::int AS count
        FROM codegen_sandbox_leases
        GROUP BY backend, status
        ORDER BY backend, status
      `),
      pool.query(`
        SELECT
          regexp_replace(metadata->>'step', '_complete$', '') AS phase,
          count(*)::int AS count,
          round(avg((metadata->>'durationMs')::numeric))::int AS avg_ms,
          max((metadata->>'durationMs')::numeric)::int AS max_ms
        FROM task_events
        WHERE event_name = 'task.progress'
          AND metadata ? 'durationMs'
          AND (metadata->>'step') ~ '_complete$'
        GROUP BY phase
        ORDER BY phase
      `),
      pool.query(`
        SELECT
          metadata->>'cacheType' AS cache_type,
          metadata->>'cacheStatus' AS cache_status,
          count(*)::int AS count
        FROM task_events
        WHERE event_name = 'task.progress'
          AND metadata ? 'cacheType'
          AND metadata ? 'cacheStatus'
        GROUP BY cache_type, cache_status
        ORDER BY cache_type, cache_status
      `)
    ]);
    return {
      tasksByStatus: tasks.rows.map((row) => ({ status: String(row.status), count: Number(row.count) })),
      agentTaskBacklog: taskBacklog.rows.map((row) => ({
        backend: String(row.backend),
        status: String(row.status),
        count: Number(row.count),
        oldestAgeSeconds: Number(row.oldest_age_seconds)
      })),
      sandboxRunsByStatus: sandboxRuns.rows.map((row) => ({ status: String(row.status), count: Number(row.count) })),
      codegenSandboxLeases: codegenSandboxLeases.rows.map((row) => ({
        backend: String(row.backend),
        status: String(row.status),
        count: Number(row.count)
      })),
      codegenPhaseDurations: phaseDurations.rows.map((row) => ({
        phase: String(row.phase),
        count: Number(row.count),
        avgMs: Number(row.avg_ms),
        maxMs: Number(row.max_ms)
      })),
      sandboxCacheEvents: cacheEvents.rows.map((row) => ({
        cacheType: String(row.cache_type),
        cacheStatus: String(row.cache_status),
        count: Number(row.count)
      }))
    };
  }
