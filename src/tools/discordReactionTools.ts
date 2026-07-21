import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";

export type AddDiscordReactionInput = {
  messageIdOrUrl?: string;
  emoji?: string;
};

type DiscordReactionTarget = {
  guildId: string;
  channelId: string;
  messageId: string;
};

const DISCORD_MESSAGE_URL = /^https?:\/\/(?:www\.)?discord(?:app)?\.com\/channels\/(\d{5,25})\/(\d{5,25})\/(\d{5,25})\/?$/i;
const DISCORD_MESSAGE_URL_IN_TEXT = /https?:\/\/(?:www\.)?discord(?:app)?\.com\/channels\/(\d{5,25})\/(\d{5,25})\/(\d{5,25})\/?/giu;
const DISCORD_ID = /^\d{5,25}$/;
const CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_]{2,32}:\d{5,25}>$/;
const UNICODE_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u;
const EXPLICIT_REACTION_INTENT = /(?:\b(?:react|add|put|place|leave)\b[\s\S]{0,80}(?:\p{Extended_Pictographic}|\b(?:emoji|emote|reaction)\b)|(?:\p{Extended_Pictographic}|\b(?:emoji|emote|reaction)\b)[\s\S]{0,80}\b(?:react|add|put|place|leave)\b)/iu;

export async function addDiscordReaction(
  ctx: ToolContext,
  input: AddDiscordReactionInput,
  currentRequestText: string,
): Promise<string> {
  const emoji = input.emoji?.trim() ?? "";
  const targetNamedInCurrentRequest = requestNamesReactionTarget(currentRequestText, input.messageIdOrUrl);
  if (ctx.mutationAuthorizedByCurrentInput !== true || (!EXPLICIT_REACTION_INTENT.test(currentRequestText) && !targetNamedInCurrentRequest)) {
    return auditReactionFailure(ctx, input, "missing_explicit_current_turn_intent",
      "I can only add a reaction when the current Discord message explicitly asks me to react or add an emoji.");
  }
  if (!isSupportedReactionEmoji(emoji)) {
    return auditReactionFailure(ctx, input, "invalid_emoji",
      "Provide exactly one Unicode emoji or one current-server custom emoji mention.");
  }
  if (CUSTOM_EMOJI.test(emoji) && !ctx.discordGuildEmojis?.some((candidate) => candidate.mention === emoji)) {
    return auditReactionFailure(ctx, input, "custom_emoji_unavailable",
      "That custom emoji is not available in the current Discord server.");
  }

  const target = parseDiscordReactionTarget(input.messageIdOrUrl, ctx.guildId, ctx.channelId);
  if (!target) {
    return auditReactionFailure(ctx, input, "invalid_message_target",
      "Provide an exact Discord message URL, or a message ID from the current channel. Resolve a described message with Discord search first.");
  }
  if (target.guildId !== ctx.guildId || !ctx.visibleChannelIds.includes(target.channelId)) {
    return auditReactionFailure(ctx, input, "message_not_visible",
      "I cannot react to that message because its channel is outside your current Discord visibility.");
  }
  if (!ctx.addDiscordReaction) {
    return auditReactionFailure(ctx, input, "reaction_runtime_unavailable",
      "I cannot add a Discord reaction from this runtime.");
  }

  try {
    const result = await ctx.addDiscordReaction({
      channelId: target.channelId,
      messageId: target.messageId,
      emoji,
    });
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "addDiscordReaction",
      argumentsSummary: summarizeForAudit({ target, emoji }),
      resultSummary: summarizeForAudit({ status: "added", messageId: result.messageId, channelId: result.channelId }),
    });
    return `Added ${emoji} to the Discord message: ${result.url}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "addDiscordReaction",
      argumentsSummary: summarizeForAudit({ target, emoji }),
      resultSummary: summarizeForAudit({ status: "failed", error: message }),
      error: message,
    });
    return `I could not add that Discord reaction: ${message}`;
  }
}

function requestNamesReactionTarget(currentRequestText: string, rawTarget: string | undefined): boolean {
  const target = rawTarget?.trim();
  if (!target) return false;
  const parsedTarget = target.match(DISCORD_MESSAGE_URL);
  if (!parsedTarget) return false;
  for (const match of currentRequestText.matchAll(DISCORD_MESSAGE_URL_IN_TEXT)) {
    if (match[1] === parsedTarget[1] && match[2] === parsedTarget[2] && match[3] === parsedTarget[3]) return true;
  }
  return false;
}

export function parseDiscordReactionTarget(
  raw: string | undefined,
  currentGuildId: string,
  currentChannelId: string,
): DiscordReactionTarget | null {
  const value = raw?.trim() ?? "";
  const urlMatch = value.match(DISCORD_MESSAGE_URL);
  if (urlMatch) {
    return { guildId: urlMatch[1]!, channelId: urlMatch[2]!, messageId: urlMatch[3]! };
  }
  if (DISCORD_ID.test(value)) {
    return { guildId: currentGuildId, channelId: currentChannelId, messageId: value };
  }
  return null;
}

export function isSupportedReactionEmoji(value: string): boolean {
  if (!value || value.length > 100) return false;
  if (CUSTOM_EMOJI.test(value)) return true;
  if (!UNICODE_EMOJI.test(value)) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1 && !/[A-Za-z]/.test(value);
}

async function auditReactionFailure(
  ctx: ToolContext,
  input: AddDiscordReactionInput,
  errorCode: string,
  response: string,
): Promise<string> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "addDiscordReaction",
    argumentsSummary: summarizeForAudit(input),
    resultSummary: summarizeForAudit({ status: "rejected", errorCode }),
    error: errorCode,
  });
  return response;
}
