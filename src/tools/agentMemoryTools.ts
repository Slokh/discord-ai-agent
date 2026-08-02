import { summarizeForAudit } from "../util/text.js";
import type { AgentResponse, ToolContext } from "./types.js";
import { extractDiscordMessageId } from "./toolContext.js";
import { boundedLimit, formatAgentMemoryStats, formatRecentAgentMemory, formatRowCount, formatTurnCount } from "./discordToolShared.js";

const MAX_UNDO_TURNS = 10;

export async function undoConversationTurns(ctx: ToolContext, count?: number): Promise<string> {
  return undoConversationTurnsCore(ctx, count);
}

export async function undoConversationTurnsResponse(ctx: ToolContext, count?: number): Promise<AgentResponse> {
  let deleted = false;
  let cleanupFailed = false;
  const content = await undoConversationTurnsCore(ctx, count, (failed) => {
    deleted = true;
    cleanupFailed = failed;
  });
  return {
    content,
    status: deleted ? cleanupFailed ? "partial" : "ok" : "error",
    retryable: false,
    outcome: { kind: "conversation_undo", state: deleted ? "succeeded" : "failed", terminal: true },
  };
}

async function undoConversationTurnsCore(ctx: ToolContext, count?: number, onDeleted?: (cleanupFailed: boolean) => void): Promise<string> {
  const threadKey = ctx.threadKey ?? `discord:${ctx.guildId}:${ctx.channelId}`;
  const undoCount = boundedLimit(count, 1, 1, MAX_UNDO_TURNS);
  const undoResult = await ctx.repo.deleteMostRecentConversationTurns({ threadKey, count: undoCount });
  let deletedDiscordReplies = 0;
  let discordCleanupFailed = false;
  if (ctx.deleteDiscordMessageIds && undoResult.assistantDiscordMessageIds.length > 0) {
    try {
      deletedDiscordReplies = await ctx.deleteDiscordMessageIds(undoResult.assistantDiscordMessageIds);
    } catch {
      discordCleanupFailed = true;
    }
  }

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "undoConversationTurns",
    argumentsSummary: summarizeForAudit({ threadKey, count: undoCount }),
    resultSummary: summarizeForAudit({
      deletedTurns: undoResult.deletedTurns,
      deletedMemoryRows: undoResult.deletedRows,
      deletedDiscordReplies,
      discordCleanupFailed,
      targetDiscordMessageIds: undoResult.assistantDiscordMessageIds
    })
  }).catch(() => undefined);

  if (undoResult.deletedRows === 0) return "I do not have a previous reply in this channel to undo.";
  onDeleted?.(discordCleanupFailed);
  const result = `Undid my last ${formatTurnCount(undoResult.deletedTurns)} in this channel and removed ${formatRowCount(
    undoResult.deletedRows
  )} from memory.`;
  return discordCleanupFailed
    ? `${result} The saved conversation was removed, but I could not delete every older Discord reply.`
    : result;
}

export async function getRecentAgentMemory(
  ctx: ToolContext,
  input: { limit?: number; includeToolResults?: boolean } = {}
): Promise<string> {
  const threadKey = ctx.threadKey ?? `discord:${ctx.guildId}:${ctx.channelId}`;
  const limit = boundedLimit(input.limit, 12, 1, 30);
  const includeToolResults = input.includeToolResults ?? false;
  const messages = (
    await ctx.repo.recentConversationMessages({
      threadKey,
      limit,
      includeToolResults
    })
  )
    .filter((message) => !ctx.requestId || message.discordMessageId !== ctx.requestId);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getRecentAgentMemory",
    argumentsSummary: summarizeForAudit({ threadKey, limit, includeToolResults }),
    resultSummary: summarizeForAudit({ resultCount: messages.length })
  });

  if (messages.length === 0) return "I do not have recent agent memory for this channel.";
  return formatRecentAgentMemory(messages);
}

export async function getAgentMemoryStats(
  ctx: ToolContext,
  input: { sinceText?: string; sinceMessageIdOrUrl?: string; sinceAuthor?: "requester" | "anyone"; limit?: number } = {}
): Promise<string> {
  const threadKey = ctx.threadKey ?? `discord:${ctx.guildId}:${ctx.channelId}`;
  const sinceText = input.sinceText?.trim() || undefined;
  const sinceMessageId = input.sinceMessageIdOrUrl ? extractDiscordMessageId(input.sinceMessageIdOrUrl) : undefined;
  const anchorAuthorId = input.sinceAuthor === "anyone" ? null : ctx.userId;
  const stats = await ctx.repo.agentMemoryTurnStats({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    threadKey,
    anchorText: sinceText,
    anchorMessageId: sinceMessageId,
    anchorAuthorId,
    excludeMessageId: ctx.requestId,
    limit: boundedLimit(input.limit, 8, 0, 20)
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getAgentMemoryStats",
    argumentsSummary: summarizeForAudit({ threadKey, sinceText, sinceMessageId, sinceAuthor: input.sinceAuthor ?? "requester" }),
    resultSummary: summarizeForAudit({
      anchorFound: Boolean(stats.anchor),
      completedTurnCount: stats.completedTurnCount,
      recentAssistantTurns: stats.recentAssistantTurns.length
    })
  });

  if ((sinceText || sinceMessageId) && !stats.anchor) {
    const target = sinceMessageId ? `message ${sinceMessageId}` : JSON.stringify(sinceText);
    const authorScope = input.sinceAuthor === "anyone" ? "in this channel" : "from the requester in this channel";
    return `I could not find anchor ${target} ${authorScope}, so I cannot count completed agent turns after it.`;
  }
  return formatAgentMemoryStats(stats);
}
