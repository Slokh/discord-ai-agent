import type { Client, Message, MessageReaction, PartialMessage, PartialMessageReaction, PartialUser, User } from "discord.js";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, ProcessRunRecord } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { deleteDiscordMessageById, discordRemoveReaction, discordSend } from "./api.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { DiscordResponseSink } from "./responseSink.js";
import { executeDiscordAgentRequest } from "./agentDelivery.js";
import {
  canTriggerImageRegeneration,
  canTriggerReplyRegeneration,
  isImageRegenerationReaction,
  isRegenerateReplyReaction,
  involvesCodingAgentTools,
  involvesImageGenerationTools
} from "./regenerateReaction.js";
import { discordChannelThreadKey, isSelfMessage, isSelfUser, shouldProcessGuildEvent, stripBotAddress } from "./mentionParsing.js";
import { fetchDiscordMessage, recordTraceEvent, type DiscordAgentRequestInput } from "./requestContext.js";

export async function persistReactionMessageUpdate(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  reaction: MessageReaction | PartialMessageReaction
) {
  const fetchedReaction = reaction.partial ? await reaction.fetch() : reaction;
  await persistReactionMessage(input, fetchedReaction.message);
}

export async function handleUndoCrossReaction(
  input: DiscordAgentRequestInput & { client?: Client },
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<boolean> {
  const fetchedReaction = reaction.partial ? await reaction.fetch() : reaction;
  const emojiName = fetchedReaction.emoji?.name ?? null;
  if (emojiName !== "❌") return false;
  if (isSelfUser(user, client.user?.id)) return false;

  const message = fetchedReaction.message;
  const fetchedMessage = message.partial ? await message.fetch() : message;
  if (!fetchedMessage.inGuild()) return false;
  if (!shouldProcessGuildEvent(input.config.discord.guildId, fetchedMessage.guildId)) return false;
  if (!isSelfMessage(fetchedMessage as Message, client.user?.id)) return false;

  const threadKey = discordChannelThreadKey(fetchedMessage.guildId, fetchedMessage.channelId);
  const deletedMemoryRows = await input.repo
    .deleteConversationMessagesByDiscordMessageIds({ threadKey, discordMessageIds: [fetchedMessage.id] })
    .catch((error) => {
      logger.warn({ err: error, messageId: fetchedMessage.id }, "Failed to delete undone bot reply from conversation memory");
      return 0;
    });
  await deleteDiscordMessageById(fetchedMessage as Message, fetchedMessage.id).catch((error) => {
    logger.warn({ err: error, messageId: fetchedMessage.id }, "Failed to delete undone Discord bot reply");
  });
  await recordTraceEvent(input.repo, {
    eventName: "discord.reply.undone_by_reaction",
    summary: "Removed bot reply from memory after ❌ reaction",
    metadata: {
      replyMessageId: fetchedMessage.id,
      deletedMemoryRows,
      reactorUserId: user.id
    }
  });
  return true;
}

export async function persistReactionMessage(
  input: { config: AppConfig; repo: DiscordAiAgentRepository },
  message: Message | PartialMessage
) {
  const fetchedMessage = message.partial ? await message.fetch() : message;
  if (!fetchedMessage.inGuild()) return;
  if (!shouldProcessGuildEvent(input.config.discord.guildId, fetchedMessage.guildId)) return;
  await persistDiscordMessage(input.repo, fetchedMessage);
}

export async function handleRegenerateReplyReaction(
  input: DiscordAgentRequestInput,
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser | null
) {
  const isReplyRegen = isRegenerateReplyReaction(reaction?.emoji);
  const isImageRegen = isImageRegenerationReaction(reaction?.emoji);
  if (!isReplyRegen && !isImageRegen) return;
  if (!user || user.bot) return;
  const reactorId = user.id;
  if (!reactorId) return;

  const fetchedReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fetchedReaction.message.partial ? await fetchedReaction.message.fetch() : fetchedReaction.message;
  if (!message.inGuild()) return;
  if (!shouldProcessGuildEvent(input.config.discord.guildId, message.guildId)) return;
  if (!isSelfMessage(message as Message, client.user?.id)) return;

  const reactionLogger = logger.child({
    traceId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    replyMessageId: message.id,
    reactorId
  });

  const run = await input.repo.findProcessRunByDiscordMessageId(message.id).catch((error) => {
    reactionLogger.warn({ err: error }, "Failed to look up process run for regenerate reaction");
    return undefined;
  });
  if (!run) {
    reactionLogger.debug("Skipping regenerate reaction because no process run was found for the reply");
    return;
  }
  if (!run.messageId || !run.channelId || !run.guildId) {
    reactionLogger.debug({ runId: run.runId }, "Skipping regenerate reaction because the original request message is unavailable");
    return;
  }

  const traceId = run.traceId ?? run.runId;
  const toolLogs = await input.repo.getToolAuditLogsForTrace({ traceId, limit: 200 }).catch((error) => {
    reactionLogger.warn({ err: error, traceId }, "Failed to load tool audit logs for regenerate reaction");
    return [];
  });
  const toolNames = toolLogs.map((log) => log.toolName);
  const isImageReply = involvesImageGenerationTools(toolNames);

  // Image regeneration path: 🔄/🔁/🎲 on a bot-generated image message is
  // restricted to the original prompter only (no admin override).
  if (isImageRegen && isImageReply) {
    if (
      !canTriggerImageRegeneration({
        reactorId,
        originalPrompterId: run.userId
      })
    ) {
      reactionLogger.info("Skipping image regenerate reaction because the reactor is not the original prompter");
      await removeRegenerationReactionFor(message as Message, reactorId, fetchedReaction.emoji, reactionLogger);
      await postImageRegenerationNotAllowedReply(message, reactionLogger).catch((error) => {
        reactionLogger.warn({ err: error }, "Failed to post image regeneration not-allowed reply");
      });
      return;
    }

    await recordTraceEvent(input.repo, {
      eventName: "discord.image.regenerate.requested",
      summary: "Regenerate image requested via regeneration reaction",
      metadata: {
        replyMessageId: message.id,
        runId: run.runId,
        traceId,
        reactorId,
        originalPrompterId: run.userId ?? null,
        emoji: fetchedReaction.emoji?.name ?? null
      }
    }).catch(() => undefined);
    await removeRegenerationReactionFor(message as Message, reactorId, fetchedReaction.emoji, reactionLogger);

    await regenerateDiscordAgentReply({
      input,
      client,
      run,
      replyMessage: message as Message,
      reactionLogger
    }).catch((error) => {
      reactionLogger.error({ err: error }, "Regenerate image failed");
    });
    return;
  }

  // Reply regeneration path only applies to the 🔄 reply-regeneration reaction.
  // 🔁/🎲 on a non-image reply are silently ignored.
  if (!isReplyRegen) return;

  let memberPermissions: { has: (permission: bigint) => boolean } | null | undefined;
  try {
    const member = await message.guild.members.fetch(reactorId);
    memberPermissions = member.permissions as unknown as { has: (permission: bigint) => boolean };
  } catch (error) {
    reactionLogger.warn({ err: error, reactorId }, "Failed to fetch reacting member for regenerate reaction permission check");
    memberPermissions = null;
  }
  if (
    !canTriggerReplyRegeneration({
      reactorId,
      originalRequesterId: run.userId,
      memberPermissions
    })
  ) {
    reactionLogger.info("Skipping regenerate reaction because the reactor is not the original requester or an admin");
    return;
  }

  if (involvesCodingAgentTools(toolNames)) {
    reactionLogger.info(
      { toolCount: toolLogs.length, toolNames: toolLogs.map((log) => log.toolName) },
      "Skipping regenerate reaction because the reply involved a coding-agent tool"
    );
    await removeRegenerationReactionFor(message as Message, reactorId, fetchedReaction.emoji, reactionLogger);
    return;
  }

  await recordTraceEvent(input.repo, {
    eventName: "discord.reply.regenerate.requested",
    summary: "Regenerate reply requested via counterclockwise-arrows reaction",
    metadata: {
      replyMessageId: message.id,
      runId: run.runId,
      traceId,
      reactorId,
      originalRequesterId: run.userId ?? null
    }
  }).catch(() => undefined);
  await removeRegenerationReactionFor(message as Message, reactorId, fetchedReaction.emoji, reactionLogger);

  await regenerateDiscordAgentReply({
    input,
    client,
    run,
    replyMessage: message as Message,
    reactionLogger
  }).catch((error) => {
    reactionLogger.error({ err: error }, "Regenerate reply failed");
  });
}

async function removeRegenerationReactionFor(
  message: Message,
  reactorId: string,
  emoji: ReactionEmojiLike | null | undefined,
  requestLogger: Logger
) {
  const target = message.reactions.cache.find((candidate) =>
    candidate.emoji.id === (emoji?.id ?? null) && candidate.emoji.name === (emoji?.name ?? null)
  );
  if (!target) return;
  try {
    const result = await discordRemoveReaction(target, reactorId, { logger: requestLogger });
    if (!result.ok) throw result.error;
    requestLogger.debug({ emoji: target.emoji.name }, "Removed regeneration reaction");
  } catch (error) {
    requestLogger.warn({ err: error, emoji: target.emoji.name }, "Failed to remove regeneration reaction");
  }
}

type ReactionEmojiLike = { id?: string | null; name?: string | null };

const IMAGE_REGENERATION_NOT_ALLOWED_REPLY =
  "Only the person who originally requested this image can regenerate it.";

async function postImageRegenerationNotAllowedReply(message: Message<true>, requestLogger: Logger) {
  try {
    if (!message.channel.isSendable?.()) return;
    const result = await discordSend(message.channel, { content: IMAGE_REGENERATION_NOT_ALLOWED_REPLY, allowedMentions: { parse: [] } }, { logger: requestLogger });
    if (!result.ok) return;
    requestLogger.debug("Posted image regeneration not-allowed reply");
  } catch (error) {
    requestLogger.warn({ err: error }, "Failed to post image regeneration not-allowed reply");
  }
}

async function regenerateDiscordAgentReply(input: {
  input: DiscordAgentRequestInput;
  client: Client;
  run: ProcessRunRecord;
  replyMessage: Message;
  reactionLogger: Logger;
}) {
  const { input: ctx, client, run, replyMessage, reactionLogger } = input;
  const original = await fetchOriginalRequestMessage({ client, run, requestLogger: reactionLogger });
  if (!original) {
    reactionLogger.warn({ runId: run.runId, originalMessageId: run.messageId }, "Could not fetch original request message for regenerate");
    return;
  }
  const botRoleIds = Array.isArray((run.metadata as Record<string, unknown>).botRoleIds)
    ? ((run.metadata as Record<string, unknown>).botRoleIds as string[])
    : [];
  const text = stripBotAddress(original.content, client.user?.id ?? "", botRoleIds).trim();
  if (!text) {
    reactionLogger.warn({ runId: run.runId }, "Skipping regenerate because original prompt text could not be recovered");
    return;
  }

  const threadKey = discordChannelThreadKey(run.guildId ?? original.guildId ?? "", run.channelId ?? original.channelId ?? "");
  await ctx.repo
    .deleteConversationMessagesByDiscordMessageIds({
      threadKey,
      discordMessageIds: [run.messageId ?? original.id, replyMessage.id]
    })
    .catch((error) => reactionLogger.warn({ err: error }, "Failed to remove prior turns before regenerating reply"));

  const responseSink = new DiscordResponseSink({
    client,
    sourceMessage: original,
    maxReplyChars: ctx.config.maxReplyChars,
    loadingReactionEmoji: ctx.config.discord.loadingReaction,
    logger: reactionLogger,
    statusMessage: replyMessage,
    deliveryKey: run.runId
  });
  await responseSink.acknowledge();
  await responseSink.updateStatus("Regenerating that response...").catch((error) => {
    reactionLogger.warn({ err: error }, "Failed to post regenerate status update");
  });
  reactionLogger.info({ runId: run.runId, originalMessageId: original.id, replyMessageId: replyMessage.id }, "Regenerating Discord reply");

  await executeDiscordAgentRequest(ctx, client, original, responseSink, {
    requestId: run.runId,
    text,
    rawContent: original.content,
    botRoleIds,
    messageStartedAt: Date.now()
  });
}

async function fetchOriginalRequestMessage(input: {
  client: Client;
  run: ProcessRunRecord;
  requestLogger: Logger;
}): Promise<Message | null> {
  if (!input.run.messageId || !input.run.channelId) return null;
  try {
    return await fetchDiscordMessage(input.client, input.run.channelId, input.run.messageId);
  } catch (error) {
    input.requestLogger.warn(
      { err: error, runId: input.run.runId, originalMessageId: input.run.messageId, channelId: input.run.channelId },
      "Failed to fetch original request message for regenerate"
    );
    return null;
  }
}
