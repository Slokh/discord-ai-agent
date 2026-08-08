import type { Client, Message } from "discord.js";
import { embeddingPriorityForMessageTimestamp } from "../jobs/embeddingPriority.js";
import type { JobRuntime } from "../jobs/queue.js";
import { ensureAgentRuntimePromptExecution, finishAgentRuntimePromptExecution } from "../agent/runtimeLedger.js";
import { enqueueAgentRuntimeSessionExecution } from "../agent/runtimeLifecycle.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { indexableMessageText, persistDiscordMessage } from "./messagePersistence.js";
import { discordEmbedContextsFromMessage } from "./embedContext.js";
import { DiscordResponseSink } from "./responseSink.js";
import { executeDiscordAgentRequest } from "./agentDelivery.js";
import {
  discordChannelThreadKey,
  explicitRoleMentionIds,
  hasExplicitBotAddress,
  isSelfMessage,
  resolveBotMentionContext,
  stripBotAddress
} from "./mentionParsing.js";
import { discordAttachmentContextsFromMessage, discordForwardedMessageSnapshot, isDiscordImageAttachment } from "./replyContext.js";
import { prepareDiscordAgentTurn } from "./turnPreparation.js";
import {
  markDiscordDeliveryDelivered,
  type DiscordAgentRequestInput
} from "./requestContext.js";

export async function handleMessageCreate(
  input: DiscordAgentRequestInput,
  client: Client,
  message: Message
) {
  const messageStartedAt = Date.now();
  if (!message.inGuild()) return;
  if (input.config.discord.guildId && message.guildId !== input.config.discord.guildId) {
    logger.debug(
      { messageId: message.id, guildId: message.guildId, configuredGuildId: input.config.discord.guildId },
      "Ignoring message from unconfigured guild"
    );
    return;
  }
  if (isSelfMessage(message, client.user?.id)) {
    await persistDiscordMessage(input.repo, message);
    logger.debug({ messageId: message.id, channelId: message.channelId }, "Persisted self-authored Discord message without invoking the agent");
    return;
  }

  await persistDiscordMessage(input.repo, message);
  logger.debug(
    {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      contentChars: message.content?.length ?? 0
    },
    "Persisted incoming Discord message"
  );

  if (message.author.bot) {
    logger.debug({ messageId: message.id, channelId: message.channelId, authorId: message.author.id }, "Ignoring bot-authored Discord message");
    return;
  }
  if (!client.user) {
    logger.warn({ messageId: message.id }, "Ignoring message because Discord client user is not ready");
    return;
  }

  const mentionContext = await resolveBotMentionContext(message, client.user.id);
  if (!mentionContext.addressed) {
    queueIncomingMessageEmbedding(input, message, client.user.id, "message_create", mentionContext.botRoleIds);
    logger.debug(
      {
        messageId: message.id,
        channelId: message.channelId,
        authorId: message.author.id,
        contentPreview: previewText(message.content),
        mentionedRoleIds: explicitRoleMentionIds(message.content),
        botRoleIds: mentionContext.botRoleIds
      },
      "Ignoring Discord message without explicit Discord AI Agent mention"
    );
    return;
  }

  if (await input.repo.isUserInteractionBlocked({ guildId: message.guildId, userId: message.author.id })) {
    logger.info(
      {
        messageId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        contentPreview: previewText(message.content),
        mentionKind: mentionContext.kind ?? "unknown",
        botRoleIds: mentionContext.botRoleIds
      },
      "Ignoring Discord AI Agent mention from interaction-blocked user"
    );
    return;
  }

  const requestId = message.id;
  const requestAttachments = discordAttachmentContextsFromMessage(message);
  const requestEmbeds = discordEmbedContextsFromMessage(message);
  const text = discordPromptText(message, client.user.id, mentionContext.botRoleIds, requestAttachments.length, requestEmbeds.length);
  const requestLogger = logger.child({
    traceId: message.id,
    requestId,
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id
  });
  requestLogger.info(
    {
      contentPreview: previewText(text),
      rawContentPreview: previewText(message.content),
      mentionKind: mentionContext.kind,
      botRoleIds: mentionContext.botRoleIds,
      attachmentCount: requestAttachments.length,
      imageAttachmentCount: requestAttachments.filter(isDiscordImageAttachment).length,
      embedCount: requestEmbeds.length
    },
    "Discord AI Agent mention received"
  );
  const responseSink = new DiscordResponseSink({
    client,
    sourceMessage: message,
    maxReplyChars: input.config.maxReplyChars,
    loadingReactionEmoji: input.config.discord.loadingReaction,
    deliveryKey: requestId,
    logger: requestLogger
  });
  if (input.walletService && input.config.payments.userWalletsEnabled) {
    await input.walletService.enqueueUserProvision({ guildId: message.guildId, userId: message.author.id });
  }
  const agentRuntimeExecution = await ensureAgentRuntimePromptExecution({
    agentRuntime: input.agentRuntime,
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    userDisplayName: message.member?.displayName ?? message.author.username,
    threadKey: discordChannelThreadKey(message.guildId, message.channelId),
    requestId,
    text,
    rawContent: message.content,
    discordUrl: message.url,
    status: "queued",
    source: "discord.ingress",
    qualityCohort: "member",
    executorName: input.agentExecutor?.name ?? "nanocodex",
    appRevision: input.config.appRevision,
    config: input.config
  }).catch((error) => {
    requestLogger.warn({ err: error }, "Failed to record agent runtime prompt session");
    return null;
  });
  if (!agentRuntimeExecution) {
    const errorContent = "I hit an error: could not create the agent runtime ledger for this turn.";
    await responseSink.sendError(errorContent);
    return;
  }
  await responseSink.acknowledge();
  await input.deliveryObligations?.upsertPending({
    executionId: agentRuntimeExecution.executionId,
    threadKey: agentRuntimeExecution.session.threadKey,
    guildId: message.guildId,
    channelId: message.channelId,
    statusChannelId: responseSink.statusChannelId,
    statusMessageId: responseSink.statusMessageId,
    sourceMessageId: message.id,
    metadata: { requestId, phase: "ingress" }
  }).catch((error) => requestLogger.warn({ err: error }, "Failed to record Discord delivery obligation"));
  if (input.jobs) {
    const enqueuedAt = new Date();
    try {
      const preparedTurn = await prepareDiscordAgentTurn({
        context: input,
        client,
        message,
        responseSink,
        request: {
          requestId,
          agentSessionId: agentRuntimeExecution?.session.sessionId,
          agentExecutionId: agentRuntimeExecution?.executionId,
          text,
          rawContent: message.content,
          botRoleIds: mentionContext.botRoleIds,
          requestEmbeds,
          messageStartedAt
        },
        agentRuntimeExecution,
        requestLogger,
        source: "discord.ingress"
      });
      const queueInput = {
        runId: message.id,
        traceId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
        responseChannelId: responseSink.statusChannelId,
        responseMessageId: responseSink.statusMessageId,
        turnEnvelopeArtifactId: preparedTurn.turnEnvelopeArtifactId,
        inputLinesArtifactId: preparedTurn.inputLinesArtifactId,
        text,
        rawContent: message.content,
        mentionKind: mentionContext.kind ?? "unknown",
        botRoleIds: mentionContext.botRoleIds,
        requesterDisplayName: message.member?.displayName ?? message.author.username,
        enqueuedAt: enqueuedAt.toISOString()
      };
      if (!input.agentRuntime) throw new Error("Agent runtime repository is required to enqueue Discord chat turns.");
      await enqueueAgentRuntimeSessionExecution({
          agentRuntime: input.agentRuntime,
          jobs: input.jobs,
          session: agentRuntimeExecution.session,
          execution: { executionId: agentRuntimeExecution.executionId, traceId: message.id },
          threadKey: agentRuntimeExecution.session.threadKey ?? discordChannelThreadKey(message.guildId, message.channelId),
          queue: queueInput
      });
      return;
    } catch (error) {
      requestLogger.error({ err: error }, "Failed to enqueue Discord agent request");
      await input.repo
        .deleteConversationMessagesByDiscordMessageIds({
          threadKey: discordChannelThreadKey(message.guildId, message.channelId),
          discordMessageIds: [message.id]
        })
        .catch((deleteError) => requestLogger.warn({ err: deleteError }, "Failed to remove failed queued user turn from channel memory"));
      const errorContent = `I hit an error: ${error instanceof Error ? error.message : String(error)}`;
      const finalReply = (await responseSink.sendError(errorContent)).message;
      await markDiscordDeliveryDelivered(input, agentRuntimeExecution.executionId, finalReply, requestLogger);
      await finishAgentRuntimePromptExecution({
        agentRuntime: input.agentRuntime,
        session: agentRuntimeExecution.session,
        executionId: agentRuntimeExecution.executionId,
        traceId: requestId,
        status: "failed",
        replyMessageId: finalReply.id,
        replyUrl: finalReply.url,
        responseContent: errorContent,
        error: error instanceof Error ? error.message : String(error),
        durationMs: durationMs(messageStartedAt),
        executorName: input.agentExecutor?.name ?? "nanocodex"
      }).catch((runtimeError) => requestLogger.warn({ err: runtimeError }, "Failed to mark enqueue failure in agent runtime"));
      return;
    }
  }
  await executeDiscordAgentRequest(input, client, message, responseSink, {
    requestId,
    text,
    rawContent: message.content,
    botRoleIds: mentionContext.botRoleIds,
    requestEmbeds,
    messageStartedAt
  });
}

export function discordPromptText(
  message: Pick<Message, "content" | "messageSnapshots" | "reference">,
  botUserId: string,
  botRoleIds: string[],
  attachmentCount = 0,
  embedCount = 0
) {
  const explicitText = stripBotAddress(message.content, botUserId, botRoleIds).trim();
  if (explicitText) return explicitText;
  if (discordForwardedMessageSnapshot(message as Pick<Message, "messageSnapshots">)) {
    return "Use the forwarded message and its reply chain as context, then respond helpfully.";
  }
  if (attachmentCount > 0) return "Inspect the attached content and respond helpfully.";
  if (embedCount > 0) return "Use the linked preview context and respond helpfully.";
  if (message.reference?.messageId) return "Continue from the replied-to message.";
  return "Ask briefly what I need help with.";
}

export function queueIncomingMessageEmbedding(
  input: { jobs?: JobRuntime },
  message: Message,
  botUserId: string | undefined,
  source: "message_create" | "message_update",
  botRoleIds: string[] = []
) {
  if (!indexableMessageText(message).trim()) {
    logger.debug({ messageId: message.id, channelId: message.channelId }, "Skipping embedding for empty Discord message");
    return;
  }
  if (message.author.bot) {
    logger.debug({ messageId: message.id, authorId: message.author.id }, "Skipping embedding enqueue for bot-authored message");
    return;
  }
  if (botUserId && hasExplicitBotAddress(message.content, botUserId, botRoleIds)) {
    logger.debug({ messageId: message.id, channelId: message.channelId }, "Skipping embedding enqueue for Discord AI Agent mention");
    return;
  }
  if (!input.jobs) {
    logger.debug({ messageId: message.id, channelId: message.channelId }, "Skipping embedding enqueue because job runtime is unavailable");
    return;
  }
  input.jobs
    .enqueueMessageEmbedding(message.id, {
      priority: embeddingPriorityForMessageTimestamp(message.createdTimestamp)
    })
    .then((jobId) => {
      logger.debug({ messageId: message.id, channelId: message.channelId, source, jobId }, "Queued message embedding");
    })
    .catch((error) => {
      logger.warn({ err: error, messageId: message.id, channelId: message.channelId, source }, "Failed to enqueue message embedding");
    });
}
