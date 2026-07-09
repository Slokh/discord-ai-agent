import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { visibleIndexedChannelIdsForRequest } from "./toolContext.js";
import { boundedLimit, formatDiscordChannelMatches, formatDiscordUserMatches } from "./discordToolShared.js";

export async function findDiscordUsers(ctx: ToolContext, query: string, limit?: number): Promise<string> {
  const resolvedLimit = boundedLimit(limit, 8, 1, 20);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const results = await ctx.repo.findDiscordUsers({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    query,
    limit: resolvedLimit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "findDiscordUsers",
    argumentsSummary: summarizeForAudit({ query, limit: resolvedLimit }),
    resultSummary: summarizeForAudit({ resultCount: results.length })
  });
  return formatDiscordUserMatches(results);
}

export async function findDiscordChannels(ctx: ToolContext, query: string, limit?: number): Promise<string> {
  const resolvedLimit = boundedLimit(limit, 8, 1, 20);
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const results = await ctx.repo.findDiscordChannels({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    query,
    limit: resolvedLimit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "findDiscordChannels",
    argumentsSummary: summarizeForAudit({ query, limit: resolvedLimit }),
    resultSummary: summarizeForAudit({ resultCount: results.length })
  });
  return formatDiscordChannelMatches(results);
}

