import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { visibleIndexedChannelIdsForRequest } from "./toolContext.js";

export async function listMyImprovementSignals(ctx: ToolContext, input: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(25, Math.trunc(input.limit ?? 20)));
  const visibleChannelIds = await visibleIndexedChannelIdsForRequest(ctx);
  const rows = await ctx.repo.listImprovementSignalsForReporter({
    guildId: ctx.guildId,
    reporterId: ctx.userId,
    visibleChannelIds,
    limit,
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "listMyImprovementSignals",
    argumentsSummary: summarizeForAudit({ limit, requesterScoped: true }),
    resultSummary: summarizeForAudit({ signalCount: rows.length }),
  });
  if (rows.length === 0) return "You have no active improvement reports. React with 🐛 to report a message or reply.";
  return [
    `Your active improvement reports (${rows.length}${rows.length === limit ? `, limited to ${limit}` : ""}):`,
    ...rows.map(({ signal, case: improvementCase }, index) =>
      `${index + 1}. ${improvementCase.title} — ${improvementCase.status}, ${improvementCase.severity} · reported ${signal.observedAt.toISOString()}${signal.messageId && signal.channelId ? ` · <https://discord.com/channels/${ctx.guildId}/${signal.channelId}/${signal.messageId}>` : ""}`),
  ].join("\n");
}
