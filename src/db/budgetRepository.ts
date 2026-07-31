import type { DbPool } from "./pool.js";

export type SpendBreakdownRow = { key: string; calls: number; estimatedCostUsd: number };

export class BudgetRepository {
  constructor(private readonly pool: DbPool) {}

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
