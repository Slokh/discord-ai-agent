import type { DbPool } from "./pool.js";

export type SpendBreakdownRow = { key: string; calls: number; estimatedCostUsd: number };

export class BudgetRepository {
  constructor(private readonly pool: DbPool) {}

  async getSpendSummary(input: { guildId: string; since: Date; limit?: number }): Promise<{ totalEstimatedCostUsd: number; byTool: SpendBreakdownRow[]; byUser: SpendBreakdownRow[] }> {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
    const [total, byTool, byUser] = await Promise.all([
      this.pool.query(
        `SELECT coalesce(sum(cost), 0)::float AS cost FROM (${spendRowsSql()}) spend`,
        [input.guildId, input.since]
      ),
      this.pool.query(
        `
          SELECT tool_key AS key, count(*)::int AS calls, coalesce(sum(cost), 0)::float AS cost
          FROM (${spendRowsSql()}) spend
          GROUP BY tool_key
          ORDER BY cost DESC, calls DESC, tool_key ASC
          LIMIT $3
        `,
        [input.guildId, input.since, limit]
      ),
      this.pool.query(
        `
          SELECT coalesce(user_id, 'unknown') AS key, count(*)::int AS calls, coalesce(sum(cost), 0)::float AS cost
          FROM (${spendRowsSql()}) spend
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

function spendRowsSql() {
  return `
    SELECT tool_name AS tool_key, user_id, coalesce(estimated_cost_usd, 0)::float AS cost
    FROM tool_audit_logs
    WHERE guild_id = $1 AND created_at >= $2
    UNION ALL
    SELECT 'model:' || coalesce(nullif(event.metadata->>'model', ''), nullif(execution.model, ''), 'unknown') AS tool_key,
           session.user_id,
           (event.metadata->>'estimatedCostUsd')::double precision AS cost
    FROM agent_runtime_events event
    JOIN agent_runtime_sessions session ON session.session_id = event.session_id
    LEFT JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
    WHERE session.guild_id = $1
      AND event.created_at >= $2
      AND event.event_name = 'agent.nanocodex.complete'
      AND event.metadata->>'estimatedCostUsd' ~ '^[0-9]+([.][0-9]+)?$'
  `;
}
