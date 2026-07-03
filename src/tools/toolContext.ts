import type { ToolContext } from "./types.js";

export async function visibleIndexedChannelIdsForRequest(ctx: ToolContext) {
  if (ctx.visibleIndexedChannelIds) return ctx.visibleIndexedChannelIds;
  const visibleIndexedChannelIds = await ctx.repo.getVisibleIndexedChannelIds(ctx.guildId, ctx.visibleChannelIds);
  ctx.visibleIndexedChannelIds = visibleIndexedChannelIds;
  return visibleIndexedChannelIds;
}

export function extractDiscordMessageId(value: string) {
  const trimmed = value.trim();
  const link = trimmed.match(/discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d+)/i);
  if (link?.[1]) return link[1];
  return /^\d{10,}$/.test(trimmed) ? trimmed : undefined;
}

export function extractMentionId(value: string, kind: "user" | "channel" | "role" | "any") {
  const trimmed = value.trim();
  if (kind === "user" || kind === "any") {
    const user = trimmed.match(/^<@!?(\d+)>$/);
    if (user?.[1]) return user[1];
  }
  if (kind === "channel" || kind === "any") {
    const channel = trimmed.match(/^<#(\d+)>$/);
    if (channel?.[1]) return channel[1];
  }
  if (kind === "role" || kind === "any") {
    const role = trimmed.match(/^<@&(\d+)>$/);
    if (role?.[1]) return role[1];
  }
  return /^\d{10,}$/.test(trimmed) ? trimmed : undefined;
}
