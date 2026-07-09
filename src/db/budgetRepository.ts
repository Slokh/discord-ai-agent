import type { DbPool } from "./pool.js";

export type SpendBreakdownRow = { key: string; calls: number; estimatedCostUsd: number };

export class BudgetRepository {
  constructor(private readonly pool: DbPool) {}

  async countUserChatTurnsSince(input: { guildId: string; userId: string; since: Date }): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT count(*)::int AS count
        FROM agent_runtime_executions cex
        JOIN agent_runtime_sessions cs ON cs.session_id = cex.session_id
        WHERE cex.task_id IS NULL
          AND cs.guild_id = $1
          AND cs.user_id = $2
          AND cex.created_at >= $3
          AND coalesce(cex.metadata->>'runtime', cs.metadata->>'runtime') = 'agent'
      `,
      [input.guildId, input.userId, input.since]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countUserToolCallsSince(input: { guildId: string; userId: string; toolName: string; since: Date }): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT count(*)::int AS count
        FROM tool_audit_logs
        WHERE guild_id = $1
          AND user_id = $2
          AND tool_name = $3
          AND created_at >= $4
          AND error IS NULL
      `,
      [input.guildId, input.userId, input.toolName, input.since]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countUserCodegenTasksSince(input: { guildId: string; userId: string; since: Date }): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT count(*)::int AS count
        FROM agent_tasks
        WHERE guild_id = $1
          AND user_id = $2
          AND task_type = 'code_update'
          AND created_at >= $3
      `,
      [input.guildId, input.userId, input.since]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async sumGuildEstimatedCostSince(input: { guildId: string; since: Date }): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT coalesce(sum(estimated_cost_usd), 0)::float AS cost
        FROM tool_audit_logs
        WHERE guild_id = $1
          AND created_at >= $2
      `,
      [input.guildId, input.since]
    );
    return Number(result.rows[0]?.cost ?? 0);
  }

  async getSpendSummary(input: { guildId: string; since: Date; limit?: number }): Promise<{ totalEstimatedCostUsd: number; byTool: SpendBreakdownRow[]; byUser: SpendBreakdownRow[] }> {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
    const [total, byTool, byUser] = await Promise.all([
      this.pool.query(
        `SELECT coalesce(sum(estimated_cost_usd), 0)::float AS cost FROM tool_audit_logs WHERE guild_id = $1 AND created_at >= $2`,
        [input.guildId, input.since]
      ),
      this.pool.query(
        `
          SELECT tool_name AS key, count(*)::int AS calls, coalesce(sum(estimated_cost_usd), 0)::float AS cost
          FROM tool_audit_logs
          WHERE guild_id = $1 AND created_at >= $2
          GROUP BY tool_name
          ORDER BY cost DESC, calls DESC, tool_name ASC
          LIMIT $3
        `,
        [input.guildId, input.since, limit]
      ),
      this.pool.query(
        `
          SELECT coalesce(user_id, 'unknown') AS key, count(*)::int AS calls, coalesce(sum(estimated_cost_usd), 0)::float AS cost
          FROM tool_audit_logs
          WHERE guild_id = $1 AND created_at >= $2
          GROUP BY coalesce(user_id, 'unknown')
          ORDER BY cost DESC, calls DESC, key ASC
          LIMIT $3
        `,
        [input.guildId, input.since, limit]
      )
    ]);
    return {
      totalEstimatedCostUsd: Number(total.rows[0]?.cost ?? 0),
      byTool: byTool.rows.map((row) => ({ key: String(row.key), calls: Number(row.calls), estimatedCostUsd: Number(row.cost) })),
      byUser: byUser.rows.map((row) => ({ key: String(row.key), calls: Number(row.calls), estimatedCostUsd: Number(row.cost) }))
    };
  }
}
