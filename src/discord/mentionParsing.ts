import type { Guild, Message, User } from "discord.js";
import { logger } from "../util/logger.js";

export function hasExplicitBotMention(content: string, botUserId: string): boolean {
  return botMentionPattern(botUserId).test(content);
}

export function hasExplicitBotAddress(content: string, botUserId: string, botRoleIds: string[] = []): boolean {
  if (hasExplicitBotMention(content, botUserId)) return true;
  return explicitRoleMentionIds(content).some((roleId) => botRoleIds.includes(roleId));
}

export function explicitUserMentionIds(content: string, excludedUserId?: string): string[] {
  return uniqueRegexCaptureIds(content, /<@!?(\d+)>/g).filter((id) => id !== excludedUserId);
}

export function explicitChannelMentionIds(content: string): string[] {
  return uniqueRegexCaptureIds(content, /<#(\d+)>/g);
}

export function explicitRoleMentionIds(content: string): string[] {
  return uniqueRegexCaptureIds(content, /<@&(\d+)>/g);
}

export function stripBotAddress(content: string, botUserId: string, botRoleIds: string[] = []): string {
  let stripped = content.replace(botMentionPattern(botUserId), "");
  for (const roleId of botRoleIds) {
    stripped = stripped.replace(botRoleMentionPattern(roleId), "");
  }
  return stripped.trim();
}

function botMentionPattern(botUserId: string): RegExp {
  return new RegExp(`<@!?${botUserId}>`, "g");
}

function botRoleMentionPattern(roleId: string): RegExp {
  return new RegExp(`<@&${roleId}>`, "g");
}

export async function resolveBotMentionContext(
  message: Message,
  botUserId: string
): Promise<{ addressed: boolean; kind: "user" | "role" | "reply" | null; botRoleIds: string[] }> {
  if (hasExplicitBotMention(message.content, botUserId)) {
    return { addressed: true, kind: "user", botRoleIds: [] };
  }

  const mentionedRoleIds = explicitRoleMentionIds(message.content);
  if (mentionedRoleIds.length > 0) {
    const botRoleIds = await botManagedRoleIds(message.guild, botUserId);
    if (mentionedRoleIds.some((roleId) => botRoleIds.includes(roleId))) {
      return { addressed: true, kind: "role", botRoleIds };
    }
    return { addressed: false, kind: null, botRoleIds };
  }

  if (await isReplyToBotMessage(message, botUserId)) {
    return { addressed: true, kind: "reply", botRoleIds: [] };
  }

  return { addressed: false, kind: null, botRoleIds: [] };
}

async function isReplyToBotMessage(message: Message, botUserId: string): Promise<boolean> {
  const reference = message.reference;
  if (!reference?.messageId) return false;
  try {
    const parent = await message.fetchReference();
    return parent.author?.id === botUserId;
  } catch (error) {
    logger.warn(
      { err: error, referencedMessageId: reference.messageId, referencedChannelId: reference.channelId },
      "Failed to fetch Discord reply reference for bot mention resolution"
    );
    return false;
  }
}

async function botManagedRoleIds(guild: Guild | null, botUserId: string): Promise<string[]> {
  if (!guild) return [];
  const cached = managedRoleIdsForBot(guild, botUserId);
  if (cached.length > 0) return cached;
  await guild.roles.fetch().catch((error) => {
    logger.warn({ err: error, guildId: guild.id }, "Failed to fetch guild roles for bot mention resolution");
  });
  return managedRoleIdsForBot(guild, botUserId);
}

function managedRoleIdsForBot(guild: Guild, botUserId: string) {
  return guild.roles.cache
    .filter((role) => (role.tags as { botId?: string } | null | undefined)?.botId === botUserId)
    .map((role) => role.id);
}

function uniqueRegexCaptureIds(content: string, pattern: RegExp): string[] {
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function isSelfMessage(message: Pick<Message, "author">, selfUserId?: string | null) {
  return Boolean(selfUserId && message.author.id === selfUserId);
}

export function isSelfUser(user: Pick<User, "id"> | null | undefined, selfUserId?: string | null) {
  return Boolean(selfUserId && user?.id === selfUserId);
}

export function shouldProcessGuildEvent(configuredGuildId: string | undefined, eventGuildId: string | null | undefined) {
  if (!configuredGuildId) return Boolean(eventGuildId);
  return eventGuildId === configuredGuildId;
}

export function discordChannelThreadKey(guildId: string, channelId: string) {
  return `discord:${guildId}:${channelId}`;
}

export function deletedMessageIdsForConfiguredGuild(
  messages: Iterable<{ id: string; guildId?: string | null }>,
  configuredGuildId?: string
) {
  return [...messages]
    .filter((message) => shouldProcessGuildEvent(configuredGuildId, message.guildId))
    .map((message) => message.id);
}
