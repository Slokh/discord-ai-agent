import type { Client, Message, MessageReaction, PartialMessage, PartialMessageReaction, PartialUser, User } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { deleteDiscordMessageById } from "./api.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { discordChannelThreadKey, isSelfMessage, isSelfUser, shouldProcessGuildEvent } from "./mentionParsing.js";
import type { DiscordAgentRequestInput } from "./requestContext.js";

export async function persistReactionMessageUpdate(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  reaction: MessageReaction | PartialMessageReaction,
) {
  const fetchedReaction = reaction.partial ? await reaction.fetch() : reaction;
  await persistReactionMessage(input, fetchedReaction.message);
}

export async function handleUndoCrossReaction(
  input: DiscordAgentRequestInput & { client?: Client },
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<boolean> {
  const fetchedReaction = reaction.partial ? await reaction.fetch() : reaction;
  if (fetchedReaction.emoji?.name !== "❌") return false;
  if (isSelfUser(user, client.user?.id)) return false;

  const message = fetchedReaction.message;
  const fetchedMessage = message.partial ? await message.fetch() : message;
  if (!fetchedMessage.inGuild()) return false;
  if (!shouldProcessGuildEvent(input.config.discord.guildId, fetchedMessage.guildId)) return false;
  if (!isSelfMessage(fetchedMessage as Message, client.user?.id)) return false;

  const threadKey = discordChannelThreadKey(fetchedMessage.guildId, fetchedMessage.channelId);
  await input.repo
    .deleteConversationMessagesByDiscordMessageIds({ threadKey, discordMessageIds: [fetchedMessage.id] })
    .catch((error) => {
      logger.warn({ err: error, messageId: fetchedMessage.id }, "Failed to delete undone bot reply from conversation memory");
      return 0;
    });
  await deleteDiscordMessageById(fetchedMessage as Message, fetchedMessage.id).catch((error) => {
    logger.warn({ err: error, messageId: fetchedMessage.id }, "Failed to delete undone Discord bot reply");
  });
  return true;
}

export async function persistReactionMessage(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  message: Message | PartialMessage,
) {
  const fetchedMessage = message.partial ? await message.fetch() : message;
  if (!fetchedMessage.inGuild()) return;
  if (!shouldProcessGuildEvent(input.config.discord.guildId, fetchedMessage.guildId)) return;
  await persistDiscordMessage(input.repo, fetchedMessage);
}
