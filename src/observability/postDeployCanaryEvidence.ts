import type { DbPool } from "../db/pool.js";

export async function passingStatsCanaryChannel(database: Pick<DbPool, "query">, traceId: string) {
  const result = await database.query(
    `SELECT session.channel_id
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
     WHERE execution.trace_id = $1
       AND execution.status = 'succeeded'
       AND (
         SELECT count(*)
         FROM agent_runtime_events event
         WHERE event.execution_id = execution.execution_id
           AND event.event_name = 'agent.tool.complete'
           AND event.metadata->>'toolName' = 'getDiscordStats'
           AND coalesce(event.metadata->>'status', 'ok') <> 'error'
       ) = 1
     ORDER BY execution.created_at DESC
     LIMIT 1`,
    [traceId],
  );
  return channelId(result.rows[0]);
}

export async function passingWebCanaryChannel(database: Pick<DbPool, "query">, traceId: string) {
  const result = await database.query(
    `SELECT session.channel_id
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
     WHERE execution.trace_id = $1
       AND execution.status = 'succeeded'
       AND (
         SELECT count(*)
         FROM agent_runtime_events event
         WHERE event.execution_id = execution.execution_id
           AND event.event_name = 'agent.tool.complete'
           AND event.metadata->>'toolName' = 'web__run'
           AND coalesce(event.metadata->>'status', 'ok') <> 'error'
           AND coalesce((event.metadata->>'outputChars')::integer, 0) > 0
       ) = 1
       AND EXISTS (
         SELECT 1
         FROM agent_runtime_events event
         WHERE event.execution_id = execution.execution_id
           AND event.event_name = 'agent.model.call.completed'
           AND event.metadata->>'purpose' = 'external_web_research'
           AND EXISTS (
             SELECT 1
             FROM jsonb_each_text(coalesce(event.metadata->'serverToolUse', '{}'::jsonb)) AS usage(name, count)
             WHERE count::integer > 0
           )
       )
     ORDER BY execution.created_at DESC
     LIMIT 1`,
    [traceId],
  );
  return channelId(result.rows[0]);
}

export async function passingRandomCanaryChannel(database: Pick<DbPool, "query">, traceId: string) {
  const result = await database.query(
    `SELECT session.channel_id
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
     WHERE execution.trace_id = $1
       AND execution.status = 'succeeded'
       AND (
         SELECT count(*)
         FROM agent_runtime_events event
         WHERE event.execution_id = execution.execution_id
           AND event.event_name = 'agent.tool.complete'
           AND event.metadata->>'toolName' = 'drawRandom'
           AND coalesce(event.metadata->>'status', 'ok') <> 'error'
       ) = 1
       AND NOT EXISTS (
         SELECT 1
         FROM agent_runtime_events event
         WHERE event.execution_id = execution.execution_id
           AND (event.level = 'error' OR event.metadata->>'status' = 'error')
       )
     ORDER BY execution.created_at DESC
     LIMIT 1`,
    [traceId],
  );
  return channelId(result.rows[0]);
}

function channelId(row: Record<string, unknown> | undefined) {
  return typeof row?.channel_id === "string" ? row.channel_id : undefined;
}
