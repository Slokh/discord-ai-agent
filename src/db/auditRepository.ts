import type { DbPool } from "./pool.js";
import { currentTraceContext } from "../util/trace.js";
import { rowToToolAuditLog } from "./shared.js";
import type { ToolAuditLog } from "./shared.js";

export async function auditTool(pool: DbPool, input: {
    traceId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    toolName: string;
    argumentsSummary?: string | null;
    resultSummary?: string | null;
    error?: string | null;
    model?: string | null;
    estimatedCostUsd?: number | null;
  }) {
    const trace = currentTraceContext();
    await pool.query(
      `
        INSERT INTO tool_audit_logs(
          trace_id, guild_id, channel_id, user_id, tool_name, arguments_summary,
          result_summary, error, model, estimated_cost_usd
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        input.traceId ?? trace?.traceId ?? null,
        input.guildId ?? trace?.guildId ?? null,
        input.channelId ?? trace?.channelId ?? null,
        input.userId ?? trace?.userId ?? null,
        input.toolName,
        input.argumentsSummary ?? null,
        input.resultSummary ?? null,
        input.error ?? null,
        input.model ?? null,
        input.estimatedCostUsd ?? null
      ]
    );
  }

export async function getToolAuditLogs(pool: DbPool, input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<ToolAuditLog[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const result = await pool.query(
      `
        SELECT
          id, trace_id, guild_id, channel_id, user_id, tool_name, arguments_summary,
          result_summary, error, model, estimated_cost_usd, created_at
        FROM tool_audit_logs
        WHERE guild_id = $1
          AND ($2::text IS NULL OR trace_id = $2)
          AND (channel_id IS NULL OR channel_id = ANY($3::text[]))
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `,
      [input.guildId, input.traceId ?? null, input.visibleChannelIds, limit]
    );
    return result.rows.map(rowToToolAuditLog);
  }

export async function getToolAuditLogsForTrace(pool: DbPool, input: { traceId: string; limit?: number }): Promise<ToolAuditLog[]> {
    const limit = Math.max(1, Math.min(300, Math.trunc(input.limit ?? 100)));
    const result = await pool.query(
      `
        SELECT
          id, trace_id, guild_id, channel_id, user_id, tool_name, arguments_summary,
          result_summary, error, model, estimated_cost_usd, created_at
        FROM tool_audit_logs
        WHERE trace_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      `,
      [input.traceId, limit]
    );
    return result.rows.map(rowToToolAuditLog);
  }
