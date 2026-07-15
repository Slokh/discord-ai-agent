import type { Client, Message } from "discord.js";
import { embeddingPriorityForMessageTimestamp, type JobRuntime } from "../jobs/queue.js";
import { ensureAgentRuntimePromptExecution, finishAgentRuntimePromptExecution } from "../agent/runtimeLedger.js";
import { enqueueAgentRuntimeSessionExecution } from "../agent/runtimeControlPlane.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { persistDiscordMessage } from "./messagePersistence.js";
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
import { discordAttachmentContextsFromMessage, isDiscordImageAttachment } from "./replyContext.js";
import { prepareDiscordAgentTurn } from "./turnPreparation.js";
import {
  discordTraceFooter,
  markDiscordDeliveryDelivered,
  recordTraceEvent,
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
    logger.debug({ messageId: message.id, channelId: message.channelId }, "Ignoring self-authored Discord message");
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
  const text = stripBotAddress(message.content, client.user.id, mentionContext.botRoleIds).trim();
  const requestAttachments = discordAttachmentContextsFromMessage(message);
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
      imageAttachmentCount: requestAttachments.filter(isDiscordImageAttachment).length
    },
    "Discord AI Agent mention received"
  );
  await recordTraceEvent(input.repo, {
    eventName: "discord.mention.received",
    summary: previewText(text),
    metadata: {
      rawContentPreview: previewText(message.content),
      mentionKind: mentionContext.kind,
      attachmentCount: requestAttachments.length,
      imageAttachmentCount: requestAttachments.filter(isDiscordImageAttachment).length
    }
  });
  const responseSink = new DiscordResponseSink({
    client,
    sourceMessage: message,
    maxReplyChars: input.config.maxReplyChars,
    loadingReactionEmoji: input.config.discord.loadingReaction,
    logger: requestLogger
  });
  const budgetDecision = await checkIngressBudget(input, {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    requestId,
    text
  });
  if (!budgetDecision.allowed) {
    requestLogger.info({ reason: budgetDecision.reason }, "Discord AI Agent mention rejected by budget limits");
    await recordTraceEvent(input.repo, {
      eventName: "budget.ingress.rejected",
      level: "warn",
      summary: budgetDecision.reason,
      metadata: budgetDecision.metadata
    });
    await responseSink.sendError(budgetDecision.message, discordTraceFooter(input.config, requestId, messageStartedAt));
    return;
  }
  if (input.walletService && input.config.payments.userWalletsEnabled) {
    await input.walletService.enqueueUserProvision(
      { guildId: message.guildId, userId: message.author.id },
      async (event) => {
        await recordTraceEvent(input.repo, {
          eventName: event.eventName,
          level: event.level,
          summary: event.summary,
          metadata: event.metadata,
          traceId: requestId,
          requestId,
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          messageId: message.id
        });
      }
    );
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
    executorName: input.agentExecutor?.name ?? "in-process",
    appRevision: input.config.appRevision,
    config: input.config
  }).catch((error) => {
    requestLogger.warn({ err: error }, "Failed to record agent runtime prompt session");
    return null;
  });
  if (!agentRuntimeExecution) {
    const errorContent = "I hit an error: could not create the agent runtime ledger for this turn.";
    await responseSink.sendError(errorContent, discordTraceFooter(input.config, requestId, messageStartedAt));
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
  await recordTraceEvent(input.repo, {
    eventName: "discord.acknowledgement.sent",
    summary: "Added loading reaction acknowledgement",
    metadata: { acknowledgement: "loading_reaction" }
  });
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
      const jobId = (
        await enqueueAgentRuntimeSessionExecution({
          agentRuntime: input.agentRuntime,
          jobs: input.jobs,
          session: agentRuntimeExecution.session,
          execution: { executionId: agentRuntimeExecution.executionId, traceId: message.id },
          threadKey: agentRuntimeExecution.session.threadKey ?? discordChannelThreadKey(message.guildId, message.channelId),
          queue: queueInput
        })
      ).jobId;
      await recordTraceEvent(input.repo, {
        eventName: "discord.agent_request.enqueued",
        summary: "Queued Discord mention for worker processing",
        metadata: { jobId, turnEnvelopeArtifactId: preparedTurn.turnEnvelopeArtifactId, inputLinesArtifactId: preparedTurn.inputLinesArtifactId }
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
      const finalReply = (await responseSink.sendError(errorContent, discordTraceFooter(input.config, requestId, messageStartedAt))).message;
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
        executorName: input.agentExecutor?.name ?? "in-process"
      }).catch((runtimeError) => requestLogger.warn({ err: runtimeError }, "Failed to mark enqueue failure in agent runtime"));
      return;
    }
  }
  await executeDiscordAgentRequest(input, client, message, responseSink, {
    requestId,
    text,
    rawContent: message.content,
    botRoleIds: mentionContext.botRoleIds,
    messageStartedAt
  });
}

export function queueIncomingMessageEmbedding(
  input: { jobs?: JobRuntime },
  message: Message,
  botUserId: string | undefined,
  source: "message_create" | "message_update",
  botRoleIds: string[] = []
) {
  if (!message.content?.trim()) {
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

export type IngressBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: string; message: string; metadata: Record<string, unknown> };

export async function checkIngressBudget(
  input: Pick<DiscordAgentRequestInput, "budgetRepo" | "config">,
  request: { guildId: string; channelId: string; userId: string; requestId: string; text: string }
): Promise<IngressBudgetDecision> {
  const budgetRepo = input.budgetRepo;
  if (!budgetRepo) return { allowed: true };
  const dayStart = startOfUtcDay(new Date());
  const { budget } = input.config;
  if (typeof budgetRepo.reserveUserChatTurn === "function") {
    const spend = budget.guildDailyUsd >= 0
      ? await budgetRepo.sumGuildEstimatedCostSince({ guildId: request.guildId, since: dayStart })
      : 0;
    if (budget.guildDailyUsd >= 0 && spend >= budget.guildDailyUsd) {
      return {
        allowed: false,
        reason: "guild_daily_spend_exhausted",
        message: "Budget exhausted for today. Try again tomorrow.",
        metadata: { guildId: request.guildId, spend, limit: budget.guildDailyUsd },
      };
    }
    const reservation = await budgetRepo.reserveUserChatTurn({
      guildId: request.guildId,
      userId: request.userId,
      requestId: request.requestId,
      since: dayStart,
      defaultLimit: budget.userTurnsPerDay,
    });
    if (!reservation.allowed) {
      return {
        allowed: false,
        reason: "user_daily_turn_limit_exhausted",
        message: `You've hit today's AI turn limit (${reservation.limit} per day). Try again tomorrow.`,
        metadata: {
          guildId: request.guildId,
          userId: request.userId,
          turns: reservation.turns,
          limit: reservation.limit,
          limitSource: reservation.limitSource,
        },
      };
    }
    return { allowed: true };
  }
  const [turnLimitOverride, spend] = await Promise.all([
    budgetRepo.getUserTurnLimitOverride({ guildId: request.guildId, userId: request.userId }),
    budget.guildDailyUsd >= 0 ? budgetRepo.sumGuildEstimatedCostSince({ guildId: request.guildId, since: dayStart }) : Promise.resolve(0)
  ]);
  if (budget.guildDailyUsd >= 0 && spend >= budget.guildDailyUsd) {
    return {
      allowed: false,
      reason: "guild_daily_spend_exhausted",
      message: "Budget exhausted for today. Try again tomorrow.",
      metadata: { guildId: request.guildId, spend, limit: budget.guildDailyUsd }
    };
  }
  const turnLimit = turnLimitOverride ?? budget.userTurnsPerDay;
  if (turnLimit >= 0) {
    const turns = await budgetRepo.countUserChatTurnsSince({ guildId: request.guildId, userId: request.userId, since: dayStart });
    if (turns >= turnLimit) {
      return {
        allowed: false,
        reason: "user_daily_turn_limit_exhausted",
        message: `You've hit today's AI turn limit (${turnLimit} per day). Try again tomorrow.`,
        metadata: {
          guildId: request.guildId,
          userId: request.userId,
          turns,
          limit: turnLimit,
          limitSource: turnLimitOverride === undefined ? "default" : "override"
        }
      };
    }
  }
  return { allowed: true };
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
