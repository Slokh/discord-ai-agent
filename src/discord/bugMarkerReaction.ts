import type { Message, MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { shouldProcessGuildEvent } from "./mentionParsing.js";
import { recordTraceEvent } from "./requestContext.js";

export const DISCORD_BUG_MARKER_EMOJI = "🐛";

type ReactionEmojiLike = { id?: string | null; name?: string | null };

export function isDiscordBugMarkerReaction(emoji: ReactionEmojiLike | null | undefined) {
  return Boolean(emoji && !emoji.id && emoji.name === DISCORD_BUG_MARKER_EMOJI);
}

export async function handleDiscordBugMarkerReaction(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser | null,
  present: boolean
) {
  if (!isDiscordBugMarkerReaction(reaction.emoji) || !user || user.bot || !user.id) return false;
  // A removed final reaction may no longer be fetchable from Discord. Its
  // message and emoji are still present on the gateway event, which is enough
  // to delete the per-user marker.
  const sourceMessage = present && reaction.partial ? (await reaction.fetch()).message : reaction.message;
  const message = sourceMessage.partial ? await sourceMessage.fetch() : sourceMessage;
  if (!message.inGuild()) return false;
  if (!shouldProcessGuildEvent(input.config.discord.guildId, message.guildId)) return false;

  if (present) await persistDiscordMessage(input.repo, message as Message);
  await input.repo.setDiscordBugMarker({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: user.id,
    present
  });
  await recordTraceEvent(input.repo, {
    eventName: present ? "discord.bug_marker.added" : "discord.bug_marker.removed",
    summary: present ? "Added Discord bug inbox marker" : "Removed Discord bug inbox marker",
    metadata: {
      markerEmoji: DISCORD_BUG_MARKER_EMOJI,
      markerUserId: user.id,
      markedMessageId: message.id
    }
  });
  return true;
}

export async function clearDiscordBugMarkersForReaction(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  reaction: MessageReaction | PartialMessageReaction
) {
  if (!isDiscordBugMarkerReaction(reaction.emoji)) return 0;
  return clearDiscordBugMarkersForMessage(input, reaction.message);
}

export async function clearDiscordBugMarkersForMessage(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  message: MessageReaction["message"]
) {
  try {
    const fetchedMessage = message.partial ? await message.fetch() : message;
    if (!fetchedMessage.inGuild()) return 0;
    if (!shouldProcessGuildEvent(input.config.discord.guildId, fetchedMessage.guildId)) return 0;
    return await input.repo.clearDiscordBugMarkersForMessage({
      guildId: fetchedMessage.guildId,
      messageId: fetchedMessage.id
    });
  } catch (error) {
    logger.warn({ err: error }, "Failed to clear Discord bug markers");
    return 0;
  }
}
