import { summarizeForAudit } from "../util/text.js";
import type { DiscordBugMarker } from "../db/repositories.js";
import type { ToolContext } from "./types.js";
import { visibleIndexedChannelIdsForRequest } from "./toolContext.js";

export async function listDiscordBugMarkers(ctx: ToolContext, input: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(25, Math.trunc(input.limit ?? 20)));
  const visibleChannelIds = await visibleIndexedChannelIdsForRequest(ctx);
  const markers = await ctx.repo.listDiscordBugMarkers({
    guildId: ctx.guildId,
    userId: ctx.userId,
    visibleChannelIds,
    limit
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "listDiscordBugMarkers",
    argumentsSummary: summarizeForAudit({ limit, requesterScoped: true }),
    resultSummary: summarizeForAudit({ markerCount: markers.length })
  });
  if (markers.length === 0) {
    return "Your bug inbox is empty. React with 🐛 to a Discord message to mark it, then ask me to show or fix your marked bugs.";
  }
  return [
    `Your active 🐛 bug markers (${markers.length}${markers.length === limit ? `, limited to ${limit}` : ""}):`,
    "These markers belong to the current requester and are filtered to channels they can currently view. Remove the 🐛 reaction to clear an item.",
    ...markers.flatMap((marker, index) => formatBugMarker(marker, index))
  ].join("\n");
}

function formatBugMarker(marker: DiscordBugMarker, index: number) {
  const author = marker.messageAuthorUsername ? `@${marker.messageAuthorUsername}` : marker.messageAuthorId;
  const lines = [
    "",
    `[${index + 1}] Marked ${marker.markedAt.toISOString()} · ${author}${marker.messageAuthorIsBot ? " (bot)" : ""}`,
    `Marked message: ${compact(marker.messageContent) || "(no text content)"}`,
    `Message link: <${marker.messageLink}>`
  ];
  if (marker.promptMessageId && marker.promptLink) {
    const promptAuthor = marker.promptAuthorUsername ? `@${marker.promptAuthorUsername}` : marker.promptAuthorId ?? "unknown";
    lines.push(
      `Original/replied-to message by ${promptAuthor}: ${compact(marker.promptContent ?? "") || "(no text content)"}`,
      `Context link: <${marker.promptLink}>`
    );
  }
  return lines;
}

function compact(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 700 ? `${normalized.slice(0, 697)}...` : normalized;
}
