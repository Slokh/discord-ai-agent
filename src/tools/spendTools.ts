import type { ToolContext } from "./types.js";

export type SpendSummaryInput = { period?: "today" | "month"; limit?: number };

export async function getSpendSummary(ctx: ToolContext, input: SpendSummaryInput = {}): Promise<string> {
  if (!ctx.budgetRepo) return "Spend summary is unavailable because the budget repository is not configured.";
  const period = input.period === "month" ? "month" : "today";
  const since = period === "month" ? startOfUtcMonth(new Date()) : startOfUtcDay(new Date());
  const summary = await ctx.budgetRepo.getSpendSummary({ guildId: ctx.guildId, since, limit: input.limit });
  const lines = [`Estimated spend ${period === "month" ? "this month" : "today"}: $${summary.totalEstimatedCostUsd.toFixed(4)}`];
  if (summary.byTool.length) {
    lines.push("", "Top tools:");
    for (const row of summary.byTool) lines.push(`- ${row.key}: $${row.estimatedCostUsd.toFixed(4)} (${row.calls} calls)`);
  }
  if (summary.byUser.length) {
    lines.push("", "Top users:");
    for (const row of summary.byUser) lines.push(`- <@${row.key}>: $${row.estimatedCostUsd.toFixed(4)} (${row.calls} calls)`);
  }
  return lines.join("\n");
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
