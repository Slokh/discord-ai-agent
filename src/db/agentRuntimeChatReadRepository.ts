import type { DbPool } from "./pool.js";
import {
  AGENT_RUNTIME_CHAT_EXECUTION_COLUMNS,
  AGENT_RUNTIME_CHAT_EXECUTION_JOINS,
  rowToAgentRuntimeChatExecution,
} from "./shared.js";
import type { AgentRuntimeChatExecution } from "./shared.js";

/** Finds the chat execution behind a Discord message, reply, or trace ID. */
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
