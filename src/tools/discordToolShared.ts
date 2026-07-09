import { truncateForDiscord } from "../util/text.js";
import { extractMentionId, visibleIndexedChannelIdsForRequest } from "./toolContext.js";
import type { ToolContext } from "./types.js";
import type { AgentMemoryTurnStats, ConversationMessage, DiscordAttachmentSearchResult, DiscordChannelLookupResult, DiscordUserLookupResult, SearchResult, ToolAuditLog, TraceEvent } from "../db/repositories.js";

export function formatDiscordUserMatches(results: DiscordUserLookupResult[]) {
  if (results.length === 0) return "No visible indexed Discord users matched.";
  return [
    "Discord user matches:",
    ...results.map((result, index) => {
      const names = [result.globalName, result.username ? `@${result.username}` : null].filter(Boolean).join(" / ") || "(unknown user)";
      const aliases = result.aliases?.length ? ` aliases=${result.aliases.join(", ")}` : "";
      return `[${index + 1}] ${names} id=${result.id}${result.isBot ? " bot=true" : ""}${aliases} messages=${result.messageCount}${formatLastSeen(result.lastMessageAt)}`;
    })
  ].join("\n");
}

export function formatTraceEvents(events: TraceEvent[]) {
  if (events.length === 0) return "Trace events: none.";
  return [
    "Trace events:",
    ...events
      .slice()
      .reverse()
      .map((event) => {
        const duration = event.durationMs == null ? "" : ` ${event.durationMs}ms`;
        const summary = event.summary ? ` - ${truncateForDiscord(event.summary, 180)}` : "";
        return `- ${event.createdAt.toISOString()} ${event.level} ${event.eventName}${duration}${summary}`;
      })
  ].join("\n");
}

export function formatToolAuditLogs(logs: ToolAuditLog[]) {
  if (logs.length === 0) return "Tool audit logs: none.";
  return [
    "Tool audit logs:",
    ...logs
      .slice()
      .reverse()
      .map((log) => {
        const bits = [
          log.model ? `model=${log.model}` : null,
          log.estimatedCostUsd == null ? null : `cost=$${Number(log.estimatedCostUsd).toFixed(6)}`,
          log.error ? `error=${truncateForDiscord(log.error, 120)}` : null
        ].filter(Boolean);
        const result = log.resultSummary ? ` -> ${truncateForDiscord(log.resultSummary, 180)}` : "";
        return `- ${log.createdAt.toISOString()} ${log.toolName}${bits.length ? ` (${bits.join(", ")})` : ""}${result}`;
      })
  ].join("\n");
}

export function formatRecentAgentMemory(messages: ConversationMessage[]) {
  return [
    "Recent Discord AI Agent memory in this channel:",
    ...messages.map((message, index) => {
      const role = message.role === "tool" ? `tool:${typeof message.metadata.toolName === "string" ? message.metadata.toolName : "unknown"}` : message.role;
      const author = message.authorDisplayName || message.authorId || "unknown";
      const timestamp = message.createdAt.toISOString();
      const url = typeof message.metadata.discordUrl === "string" ? `\n${message.metadata.discordUrl}` : "";
      const content = truncateForDiscord(message.content, 500);
      return `[${index + 1}] ${timestamp} ${role} ${author}\n${content}${url}`;
    })
  ].join("\n\n");
}

export function formatAgentMemoryStats(stats: AgentMemoryTurnStats) {
  const lines = ["Discord AI Agent memory stats for this channel:"];
  lines.push(`- Completed assistant turns${stats.anchor ? " after anchor" : ""}: ${stats.completedTurnCount}`);
  if (stats.anchor) {
    const author = stats.anchor.authorDisplayName || stats.anchor.authorUsername || stats.anchor.authorId;
    lines.push(`- Anchor: ${stats.anchor.createdAt.toISOString()} ${author}`);
    lines.push(`  ${truncateForDiscord(stats.anchor.normalizedContent || stats.anchor.content, 220)}`);
    lines.push(`  ${stats.anchor.link}`);
  }
  if (stats.recentAssistantTurns.length > 0) {
    lines.push("- Recent counted turns:");
    for (const turn of stats.recentAssistantTurns) {
      const url = typeof turn.metadata.discordUrl === "string" ? ` ${turn.metadata.discordUrl}` : "";
      lines.push(`  - ${turn.createdAt.toISOString()}: ${truncateForDiscord(turn.content, 180)}${url}`);
    }
  }
  return lines.join("\n");
}

export function formatDiscordChannelMatches(results: DiscordChannelLookupResult[]) {
  if (results.length === 0) return "No visible indexed Discord channels matched.";
  return [
    "Discord channel matches:",
    ...results.map((result, index) => {
      const name = result.name ? `#${result.name}` : "(unnamed channel)";
      return `[${index + 1}] ${name} id=${result.id} type=${channelTypeLabel(result.type)}${result.parentId ? ` parent=${result.parentId}` : ""} messages=${result.messageCount}${formatLastSeen(result.lastMessageAt)}`;
    })
  ].join("\n");
}

export function formatMessageList(results: SearchResult[], emptyMessage: string) {
  if (results.length === 0) return emptyMessage;
  return results
    .map((result, index) => {
      const author = result.authorUsername ? `@${result.authorUsername}` : result.authorId;
      const content = truncateForDiscord(result.normalizedContent || result.content, 500);
      return `[${index + 1}] ${author} channel=${result.channelId} at ${result.createdAt.toISOString()}\n${content}\n${result.link}`;
    })
    .join("\n\n");
}

export function formatAttachmentResults(results: DiscordAttachmentSearchResult[]) {
  if (results.length === 0) return "No indexed Discord attachments matched.";
  return [
    "Discord attachment matches:",
    ...results.map((result, index) => {
      const author = result.authorUsername ? `@${result.authorUsername}` : result.authorId;
      const meta = [result.filename, result.contentType, result.sizeBytes == null ? null : `${result.sizeBytes} bytes`].filter(Boolean).join(" | ");
      const text = result.normalizedContent ? `\nMessage: ${truncateForDiscord(result.normalizedContent, 220)}` : "";
      return `[${index + 1}] ${meta || "attachment"} by ${author} channel=${result.channelId} at ${result.createdAt.toISOString()}${text}\nAttachment: ${result.url}\nMessage: ${result.link}`;
    })
  ].join("\n\n");
}

export function formatLastSeen(value: Date | null) {
  return value ? ` last=${value.toISOString()}` : "";
}

export function channelTypeLabel(type: number) {
  const labels: Record<number, string> = {
    0: "text",
    5: "announcement",
    10: "announcement_thread",
    11: "public_thread",
    12: "private_thread",
    15: "forum",
    16: "media"
  };
  return labels[type] ?? String(type);
}

export async function resolveAuthorQueries(ctx: ToolContext, queries: string[]) {
  const ids: string[] = [];
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  for (const query of uniqueStrings(queries.map(cleanLookupValue)).filter(Boolean)) {
    const matches = await ctx.repo.findDiscordUsers({
      guildId: ctx.guildId,
      visibleChannelIds: visibleIndexedChannels,
      query,
      limit: 3
    });
    ids.push(...matches.map((match) => match.id));
  }
  return uniqueStrings(ids);
}

export async function resolveAboutUserTerms(ctx: ToolContext, userIds: string[]) {
  const ids = uniqueStrings(userIds);
  if (ids.length === 0) return [];
  const references = await ctx.repo.getDiscordUserReferenceTerms({
    guildId: ctx.guildId,
    userIds: ids
  });
  return uniqueStrings([...ids.map((id) => `@user:${id}`), ...references.flatMap((reference) => reference.terms)]);
}

export async function resolveChannelQueries(ctx: ToolContext, queries: string[]) {
  const ids: string[] = [];
  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  for (const query of uniqueStrings(queries.map(cleanLookupValue)).filter(Boolean)) {
    const matches = await ctx.repo.findDiscordChannels({
      guildId: ctx.guildId,
      visibleChannelIds: visibleIndexedChannels,
      query,
      limit: 3
    });
    ids.push(...matches.map((match) => match.id));
  }
  return uniqueStrings(ids);
}

export function boundedLimit(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function normalizeIds(ids?: string[]) {
  return uniqueStrings(
    (ids ?? [])
      .map((id) => extractMentionId(id, "any") ?? id.trim())
      .filter(Boolean)
  );
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function cleanLookupValue(value: string) {
  return value.trim().replace(/^[@#]/, "");
}

export function formatTurnCount(count: number) {
  return `${count} ${count === 1 ? "turn" : "turns"}`;
}

export function formatRowCount(count: number) {
  return `${count} memory ${count === 1 ? "row" : "rows"}`;
}
