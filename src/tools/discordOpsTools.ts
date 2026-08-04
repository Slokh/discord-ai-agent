import { MESSAGE_EMBEDDING_INPUT_VERSION } from "../memory/embedding.js";
import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { effectiveAgentChatModel } from "./agentModelTools.js";

/** Returns bounded operational health for explicitly authorized operators. */
export async function reportStatus(ctx: ToolContext): Promise<string> {
  const [health, crawl, embeddingBacklog, blockedUsers] = await Promise.all([
    ctx.repo.health(),
    ctx.repo.getCrawlStatus(ctx.guildId),
    ctx.repo.embeddingBacklog({
      guildId: ctx.guildId,
      model: ctx.config.openRouter.embeddingModel,
      dimensions: ctx.config.embeddingDimensions,
      inputVersion: MESSAGE_EMBEDDING_INPUT_VERSION,
      botUserId: ctx.config.discord.clientId,
    }),
    ctx.repo.interactionBlockCount(ctx.guildId),
  ]);
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "reportStatus",
    argumentsSummary: summarizeForAudit({ guildId: ctx.guildId }),
    resultSummary: summarizeForAudit({
      messages: health.messages,
      embeddings: health.embeddings,
      embeddingBacklog,
      blockedUsers,
      toolCalls: health.toolCalls,
      crawl,
    }),
  });
  return [
    "Discord AI Agent local status:",
    `- Primary chat model: ${effectiveAgentChatModel(ctx) ?? "provider default"}${ctx.chatModelOverride ? " (server override)" : " (configured default)"}`,
    `- Messages indexed: ${health.messages}`,
    `- Embeddings stored: ${health.embeddings}`,
    `- Embeddings pending/backfill: ${embeddingBacklog}`,
    `- Conversation sessions: ${Number(health.conversationSessions ?? 0)}`,
    `- Interaction-blocked users: ${blockedUsers}`,
    `- Tool calls logged: ${health.toolCalls}`,
    `- Estimated model cost logged: $${Number(health.estimatedCostUsd ?? 0).toFixed(4)}`,
    `- Crawl: ${crawl.map((row) => `${row.status}=${row.channels} channels/${row.messages} messages`).join(", ") || "not started"}`,
  ].join("\n");
}
