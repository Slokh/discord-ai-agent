import { randomUUID } from "node:crypto";
import type { Client, Message } from "discord.js";
import type { Logger } from "pino";
import { isOpenRouterContentFilterError } from "../models/openrouter.js";
import type { DiscordAgentRequestJob } from "../jobs/queue.js";
import { isAgentRuntimeTimeoutError } from "../agent/inProcessRuntimeExecutor.js";
import { InProcessAgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import { agentRuntimeTurnInputText, assertAgentRuntimeTurnEnvelopeScope, loadAgentRuntimeTurnEnvelope } from "../agent/runtimeEnvelope.js";
import { ensureAgentRuntimePromptExecution, finishAgentRuntimePromptExecution } from "../agent/runtimeLedger.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { ToolContext } from "../tools/types.js";
import { durationMs, logger } from "../util/logger.js";
import { createDiscordGuildEmoji, deleteDiscordMessageById, fetchDiscordAttachment, fetchDiscordGuildEmojis, fetchDiscordGuildMembers, fetchDiscordUserAvatar, sendDiscordPollMessage } from "./api.js";
import { discordChannelThreadKey } from "./mentionParsing.js";
import { DiscordResponseSink, formatDiscordResponseFooter } from "./responseSink.js";
import { prepareDiscordPresentation } from "./components/renderer.js";
import { loadAgentRuntimeInputLines, prepareDiscordAgentTurn, replayPreparedDiscordAgentTurn } from "./turnPreparation.js";
import {
  attachPromptTasksToDiscordReply,
  discordTraceFooter,
  fetchDiscordMessage,
  isTerminalProcessRunStatus,
  markDiscordDeliveryDelivered,
  parseDateMs,
  recordAgentRuntimeSpan,
  recordTraceEvent,
  storeAgentRuntimeResponseArtifact,
  waitForDiscordClientReady,
  type DiscordAgentExecutionRequest,
  type DiscordAgentRequestInput
} from "./requestContext.js";

export async function runQueuedAgentRuntimeExecution(
  input: DiscordAgentRequestInput & { client: Client },
  job: DiscordAgentRequestJob
) {
  const existingDelivery = job.agentExecutionId
    ? await input.deliveryObligations?.getByExecutionId(job.agentExecutionId).catch(() => undefined)
    : undefined;
  if (existingDelivery?.state === "delivered") {
    logger.info({ runId: job.runId, agentExecutionId: job.agentExecutionId }, "Skipping queued agent runtime execution because Discord delivery already completed");
    return;
  }
  await waitForDiscordClientReady(input.client);
  const existingRun = await input.repo.getProcessRun(job.runId).catch(() => undefined);
  if (existingRun && isTerminalProcessRunStatus(existingRun.status)) {
    logger.info({ runId: job.runId, status: existingRun.status }, "Skipping queued agent runtime execution because run is already terminal");
    return;
  }

  const requestLogger = logger.child({
    traceId: job.traceId ?? job.runId,
    requestId: job.runId,
    guildId: job.guildId,
    channelId: job.channelId,
    messageId: job.messageId,
    userId: job.userId,
    inputLinesArtifactId: job.inputLinesArtifactId ?? null
  });
  const turnEnvelope = await loadAgentRuntimeTurnEnvelope({
    agentRuntime: input.agentRuntime,
    artifactId: job.turnEnvelopeArtifactId
  }).catch((error) => {
    requestLogger.warn({ err: error, turnEnvelopeArtifactId: job.turnEnvelopeArtifactId }, "Failed to load queued agent turn envelope");
    return null;
  });
  const message = await fetchDiscordMessage(input.client, job.channelId, job.messageId);
  if (!message.inGuild()) throw new Error("Queued agent runtime execution source message is no longer a guild message.");
  const responseChannelId = job.responseChannelId ?? turnEnvelope?.delivery.statusChannelId ?? undefined;
  const responseMessageId = job.responseMessageId ?? turnEnvelope?.delivery.statusMessageId ?? undefined;
  const statusMessage =
    responseChannelId && responseMessageId
      ? await fetchDiscordMessage(input.client, responseChannelId, responseMessageId).catch((error) => {
          requestLogger.warn({ err: error, responseChannelId, responseMessageId }, "Failed to fetch queued Discord status message");
          return null;
        })
      : null;
  const responseSink = new DiscordResponseSink({
    client: input.client,
    sourceMessage: message,
    maxReplyChars: input.config.maxReplyChars,
    logger: requestLogger,
    loadingReactionEmoji: input.config.discord.loadingReaction,
    statusMessage
  });
  if ((turnEnvelope?.requestKind ?? "message") === "message") await responseSink.acknowledge();
  if (job.agentExecutionId) {
    await input.deliveryObligations?.upsertPending({
      executionId: job.agentExecutionId,
      threadKey: turnEnvelope?.threadKey ?? null,
      guildId: job.guildId,
      channelId: job.channelId,
      statusChannelId: responseSink.statusChannelId,
      statusMessageId: responseSink.statusMessageId,
      sourceMessageId: job.messageId,
      metadata: { requestId: job.runId, phase: "worker" }
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to refresh Discord delivery obligation"));
  }
  await executeDiscordAgentRequest(input, input.client, message, responseSink, {
    requestId: job.runId,
    agentSessionId: job.agentSessionId,
    agentExecutionId: job.agentExecutionId,
    inputLinesArtifactId: job.inputLinesArtifactId ?? null,
    text: job.text,
    rawContent: job.rawContent,
    botRoleIds: job.botRoleIds,
    messageStartedAt: parseDateMs(job.enqueuedAt) ?? Date.now(),
    turnEnvelope,
    requestKind: turnEnvelope?.requestKind ?? "message",
    userId: job.userId,
    userDisplayName: job.requesterDisplayName,
  });
}

export async function executeDiscordAgentRequest(
  input: DiscordAgentRequestInput,
  client: Client,
  message: Message,
  responseSink: DiscordResponseSink,
  request: DiscordAgentExecutionRequest
) {
  if (!message.guildId || !message.guild) throw new Error("Discord agent request message is not attached to a guild.");
  const agentExecutor = input.agentExecutor ?? new InProcessAgentRuntimePromptExecutor();
  const guildId = message.guildId;
  const requestLogger = logger.child({
    traceId: request.requestId,
    requestId: request.requestId,
    guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: request.userId ?? request.turnEnvelope?.userId ?? message.author.id,
    inputLinesArtifactId: request.inputLinesArtifactId ?? null
  });
  const fallbackThreadKey = discordChannelThreadKey(guildId, message.channelId);
  const fallbackUserDisplayName = request.userDisplayName ?? message.member?.displayName ?? message.author.username;
  const requesterId = request.userId ?? request.turnEnvelope?.userId ?? message.author.id;
  const agentRuntimeExecution = await ensureAgentRuntimePromptExecution({
    agentRuntime: input.agentRuntime,
    guildId,
    channelId: message.channelId,
    userId: requesterId,
    userDisplayName: fallbackUserDisplayName,
    threadKey: request.turnEnvelope?.threadKey ?? fallbackThreadKey,
    agentSessionId: request.agentSessionId,
    agentExecutionId: request.agentExecutionId,
    requestId: request.requestId,
    text: request.text,
    rawContent: request.rawContent,
    discordUrl: message.url,
    status: "running",
    source: `discord.${request.requestKind ?? request.turnEnvelope?.requestKind ?? "worker"}`,
    executorName: agentExecutor.name,
    appRevision: input.config.appRevision,
    config: input.config
  }).catch((error) => {
    requestLogger.warn({ err: error }, "Failed to mark agent runtime execution running");
    return null;
  });
  if (!agentRuntimeExecution) {
    const errorContent = "I hit an error: could not create the agent runtime ledger for this turn.";
    await responseSink.sendError(errorContent, discordTraceFooter(input.config, request.requestId, request.messageStartedAt));
    return;
  }
  const preparedTurn = request.turnEnvelope
    ? await replayPreparedDiscordAgentTurn({
        context: input,
        request,
        turnEnvelope: request.turnEnvelope,
        requestLogger
      })
    : await prepareDiscordAgentTurn({
        context: input,
        client,
        message,
        responseSink,
        request,
        agentRuntimeExecution,
        requestLogger,
        source: "discord.worker"
      });
  const turnEnvelope = preparedTurn.turnEnvelope;
  const threadKey = turnEnvelope.threadKey;
  const userDisplayName = turnEnvelope.userDisplayName;
  const visibleChannelIds = turnEnvelope.visibleChannelIds;
  const mentionedUserIds = turnEnvelope.mentionedUserIds;
  const mentionedChannelIds = turnEnvelope.mentionedChannelIds;
  const replyContext = turnEnvelope.replyContext ?? undefined;
  const requestAttachments = turnEnvelope.requestAttachments;
  const priorSessionMessages = preparedTurn.priorSessionMessages;

  try {
    assertAgentRuntimeTurnEnvelopeScope(turnEnvelope, {
      requestId: request.requestId,
      sourceMessageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: requesterId
    });
    const agentStartedAt = Date.now();
    const inputLines = await loadAgentRuntimeInputLines({
      agentRuntime: input.agentRuntime,
      repo: input.repo,
      requestId: request.requestId,
      artifactId: request.inputLinesArtifactId,
      requestLogger
    });
    const discordGuildEmojis = await fetchDiscordGuildEmojis(client, turnEnvelope.guildId).catch((error) => {
      requestLogger.warn({ err: error }, "Failed to load the live Discord guild emoji palette");
      return [];
    });
    const toolContext: ToolContext = {
      config: input.config,
      repo: input.repo,
      budgetRepo: input.budgetRepo,
      rngRepo: input.rngRepo,
      walletService: input.walletService,
      agentRuntime: input.agentRuntime,
      agentRuntimeSession: agentRuntimeExecution?.session ?? null,
      agentRuntimeExecutionId: agentRuntimeExecution?.executionId ?? null,
      openRouter: input.openRouter,
      jobs: input.jobs,
      guildId: turnEnvelope.guildId,
      channelId: turnEnvelope.channelId,
      userId: turnEnvelope.userId,
      userDisplayName,
      requesterScope: Object.freeze({
        requestId: turnEnvelope.requestId,
        messageId: turnEnvelope.requestId,
        guildId: turnEnvelope.guildId,
        channelId: turnEnvelope.channelId,
        userId: turnEnvelope.userId,
        userDisplayName
      }),
      visibleChannelIds,
      mentionedUserIds,
      mentionedChannelIds,
      threadKey,
      sessionMessages: priorSessionMessages,
      replyContext,
      requestAttachments,
      requestId: request.requestId,
      requestMessageId: turnEnvelope.requestId,
      mutationAuthorizedByCurrentInput: (turnEnvelope.requestKind ?? "message") === "message",
      statusChannelId: responseSink.statusChannelId,
      statusMessageId: responseSink.statusMessageId,
      noteProgress: () => undefined,
      updateStatus: async (content) => {
        toolContext.noteProgress?.();
        const statusMessage = await responseSink.updateStatus(content);
        toolContext.statusChannelId = statusMessage.channelId;
        toolContext.statusMessageId = statusMessage.id;
      },
      deleteDiscordMessageIds: async (messageIds) => {
        let deleted = 0;
        for (const messageId of messageIds) {
          if (await deleteDiscordMessageById(message, messageId)) deleted += 1;
        }
        return deleted;
      },
      sendDiscordPoll: async (pollInput) => sendDiscordPollMessage(message, pollInput),
      createDiscordEmoji: async (emojiInput) => createDiscordGuildEmoji(client, turnEnvelope.guildId, emojiInput),
      fetchDiscordUserAvatar: async ({ userId }) => fetchDiscordUserAvatar(client, turnEnvelope.guildId, userId),
      fetchDiscordGuildMembers: async () => fetchDiscordGuildMembers(client, turnEnvelope.guildId),
      discordGuildEmojis,
      fetchDiscordAttachment: async ({ channelId, messageId, attachmentId }) =>
        fetchDiscordAttachment(client, { channelId, messageId, attachmentId })
    };
    const response = await agentExecutor.execute({
      toolContext,
      text: agentRuntimeTurnInputText(turnEnvelope),
      timeoutMs: input.config.chatTimeouts.hardMs,
      hardTimeoutMs: input.config.chatTimeouts.hardMs,
      silenceTimeoutMs: input.config.chatTimeouts.silenceMs,
      turnEnvelope,
      inputLinesArtifactId: request.inputLinesArtifactId ?? null,
      inputLines
    });
    const sourceMessageReaction = response.sourceMessageReaction
      && discordGuildEmojis.some((emoji) => emoji.mention === response.sourceMessageReaction)
      ? response.sourceMessageReaction
      : undefined;
    if (response.sourceMessageReaction && !sourceMessageReaction) {
      requestLogger.warn(
        { requestedReaction: response.sourceMessageReaction },
        "Ignored agent source-message reaction because it is not in the live guild emoji palette",
      );
    }
    await recordAgentRuntimeSpan({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution.session,
      executionId: agentRuntimeExecution.executionId,
      traceId: request.requestId,
      spanId: "agent.request",
      name: "Run model-led agent",
      status: "succeeded",
      startedAt: new Date(agentStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(agentStartedAt),
      metadata: {
        executor: agentExecutor.name,
        inputLinesArtifactId: request.inputLinesArtifactId ?? null,
        responseChars: response.content.length,
        fileCount: response.files?.length ?? 0,
        memoryEventCount: response.memoryEvents?.length ?? 0,
        sourceMessageReaction: sourceMessageReaction ?? null
      }
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to record agent runtime span"));

    requestLogger.info(
      {
        responseChars: response.content.length,
        fileCount: response.files?.length ?? 0,
        memoryEventCount: response.memoryEvents?.length ?? 0,
        sourceMessageReaction: sourceMessageReaction ?? null
      },
      "Agent response ready"
    );
    await recordTraceEvent(input.repo, {
      eventName: "agent.response.ready",
      summary: `Agent returned ${response.content.length} chars`,
      metadata: {
        executor: agentExecutor.name,
        inputLinesArtifactId: request.inputLinesArtifactId ?? null,
        responseChars: response.content.length,
        fileCount: response.files?.length ?? 0,
        memoryEventCount: response.memoryEvents?.length ?? 0,
        sourceMessageReaction: sourceMessageReaction ?? null
      }
    });
    const traceFooter = discordTraceFooter(input.config, request.requestId, request.messageStartedAt);
    const formattedFooter = response.footerLines?.length ? { ...traceFooter, extraLines: response.footerLines } : traceFooter;
    let preparedPresentation = response.discordPresentation
      ? await Promise.resolve().then(() => prepareDiscordPresentation({
          presentation: response.discordPresentation!,
          content: response.content,
          footer: formatDiscordResponseFooter(formattedFooter),
          fileNames: response.files?.map((file) => file.name),
        })).catch((error) => {
          requestLogger.warn({ err: error }, "Failed to prepare Discord rich presentation; using plain response");
          return null;
        })
      : null;
    let actionGenerationId: string | null = null;
    if (preparedPresentation?.registrations.length) {
      actionGenerationId = randomUUID();
      try {
        await input.repo.createDiscordComponentActionGeneration({
          generationId: actionGenerationId,
          originatingExecutionId: agentRuntimeExecution.executionId,
          guildId: turnEnvelope.guildId,
          channelId: turnEnvelope.channelId,
          sourceMessageId: message.id,
          ownerUserId: response.discordPresentation?.audience === "requester" ? turnEnvelope.userId : null,
          audience: response.discordPresentation?.audience ?? "requester",
          actions: preparedPresentation.registrations.map(({ token, action, singleUse }) => ({ token, action, singleUse })),
          expiresAt: new Date(Date.now() + (response.discordPresentation?.expiresInMinutes ?? 1_440) * 60_000),
        });
      } catch (error) {
        requestLogger.warn({ err: error }, "Failed to persist Discord component action generation; using plain response");
        actionGenerationId = null;
        preparedPresentation = null;
      }
    }
    const finalResult = await responseSink.sendFinal({
      content: response.content,
      files: response.files,
      footer: formattedFooter,
      presentation: preparedPresentation,
    });
    let finalReply = finalResult.message;
    let richPresentationDelivered = finalResult.usedRichPresentation;
    if (preparedPresentation && finalResult.usedRichPresentation && actionGenerationId) {
      try {
        await input.repo.activateDiscordComponentActionGeneration({
          generationId: actionGenerationId,
          responseMessageId: finalReply.id,
          expectedActionCount: preparedPresentation.registrations.length,
        });
      } catch (error) {
        requestLogger.error({ err: error, replyMessageId: finalReply.id, actionGenerationId }, "Failed to activate delivered Discord component actions");
        await input.repo.cancelDiscordComponentActionGeneration({ generationId: actionGenerationId }).catch(() => undefined);
        finalReply = await responseSink.replaceRichPresentationWithFallback(preparedPresentation) ?? finalReply;
        richPresentationDelivered = false;
      }
    } else if (actionGenerationId) {
      await input.repo.cancelDiscordComponentActionGeneration({ generationId: actionGenerationId }).catch((error) => {
        requestLogger.warn({ err: error, actionGenerationId }, "Failed to cancel undelivered Discord component actions");
      });
    }
    if (!richPresentationDelivered || !actionGenerationId) {
      await input.repo.cancelDiscordComponentActionsForResponseMessage({
        guildId: turnEnvelope.guildId,
        channelId: finalReply.channelId,
        responseMessageId: finalReply.id,
      }).catch((error) => requestLogger.warn({ err: error, replyMessageId: finalReply.id }, "Failed to invalidate replaced Discord component actions"));
    }
    await recordTraceEvent(input.repo, {
      eventName: richPresentationDelivered ? "discord.presentation.delivered" : response.discordPresentation ? "discord.presentation.fallback" : "discord.response.delivered",
      level: response.discordPresentation && !richPresentationDelivered ? "warn" : "info",
      summary: richPresentationDelivered ? "Delivered Discord Components V2 presentation" : response.discordPresentation ? "Delivered safe fallback after rich presentation failure" : "Delivered Discord response",
      metadata: { replyMessageId: finalReply.id, requestedRichPresentation: Boolean(response.discordPresentation), actionCount: preparedPresentation?.registrations.length ?? 0, actionGenerationId },
    });
    const reactionOutcome = sourceMessageReaction
      ? await responseSink.addSourceMessageReactions([sourceMessageReaction])
      : null;
    if (sourceMessageReaction) {
      await recordTraceEvent(input.repo, {
        eventName: "discord.response.reaction",
        level: reactionOutcome?.added.length ? "info" : "warn",
        summary: reactionOutcome?.added.length
          ? "Added learned custom-emote reaction to source message"
          : "Failed to add learned custom-emote reaction to source message",
        metadata: {
          emoji: sourceMessageReaction,
          sourceMessageId: message.id,
          added: reactionOutcome?.added.length === 1,
          failureCount: reactionOutcome?.failed.length ?? 0,
        },
      }).catch((error) => requestLogger.warn({ err: error }, "Failed to record learned emoji reaction trace"));
    }
    await markDiscordDeliveryDelivered(input, agentRuntimeExecution.executionId, finalReply, requestLogger);
    await attachPromptTasksToDiscordReply(input, request.requestId, finalReply, requestLogger);
    requestLogger.info({ replyMessageId: finalReply.id }, "Sent Discord final response");
    const storedResponseContent = response.storedContent ?? response.content;
    const responseRedacted = Boolean(response.storedContent);

    await finishAgentRuntimePromptExecution({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution?.session,
      executionId: agentRuntimeExecution?.executionId,
      traceId: request.requestId,
      status: "succeeded",
      replyMessageId: finalReply.id,
      replyUrl: finalReply.url,
      responseContent: storedResponseContent,
      durationMs: durationMs(request.messageStartedAt),
      executorName: agentExecutor.name
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to mark agent runtime execution succeeded"));

    if (response.memoryEvents?.length) {
      requestLogger.debug({ memoryEventCount: response.memoryEvents.length }, "Kept tool results in trace memory only");
    }

    await input.repo.appendConversationTurn({
      threadKey,
      turnId: request.requestId,
      user: {
        discordMessageId: request.requestId,
        authorId: turnEnvelope.userId,
        authorDisplayName: userDisplayName,
        content: agentRuntimeTurnInputText(turnEnvelope),
        createdAt: new Date(turnEnvelope.messageCreatedAt),
        metadata: {
          discordUrl: turnEnvelope.discordUrl,
          requestKind: turnEnvelope.requestKind ?? "message",
          sourceMessageId: message.id,
          rawContent: request.rawContent,
          attachments: requestAttachments
        }
      },
      assistant: {
        discordMessageId: finalReply.id,
        authorId: client.user?.id ?? null,
        authorDisplayName: client.user?.username ?? null,
        content: storedResponseContent,
        metadata: {
          discordUrl: finalReply.url,
          responseRedacted,
          sourceMessageReaction: reactionOutcome?.added[0] ?? null,
          files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
        }
      }
    });
    requestLogger.info({ durationMs: durationMs(request.messageStartedAt) }, "Discord mention handled");
    await recordTraceEvent(input.repo, {
      eventName: "discord.mention.handled",
      summary: "Discord mention handled",
      metadata: { replyMessageId: finalReply.id, sourceMessageReaction: reactionOutcome?.added[0] ?? null },
      durationMs: durationMs(request.messageStartedAt)
    });
    const presentationArtifactId = response.discordPresentation
      ? await storeAgentRuntimeResponseArtifact({
          agentRuntime: input.agentRuntime,
          session: agentRuntimeExecution.session,
          executionId: agentRuntimeExecution.executionId,
          traceId: request.requestId,
          name: "Discord presentation plan",
          content: JSON.stringify(response.discordPresentation, null, 2),
          metadata: { replyMessageId: finalReply.id, richPresentationDelivered, actionGenerationId },
        }).catch((error) => {
          requestLogger.warn({ err: error }, "Failed to store Discord presentation artifact");
          return null;
        })
      : null;
    await storeAgentRuntimeResponseArtifact({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution.session,
      executionId: agentRuntimeExecution.executionId,
      traceId: request.requestId,
      name: "Discord final response",
      content: storedResponseContent,
      metadata: {
        replyMessageId: finalReply.id,
        discordUrl: finalReply.url,
        responseRedacted,
        presentationArtifactId,
        richPresentationDelivered,
        actionGenerationId,
        sourceMessageReaction: reactionOutcome?.added[0] ?? null,
        files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
      }
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to store Discord response artifact"));
  } catch (error) {
    await releaseFailedRequestWager(input, request, error, requestLogger);
    if (isOpenRouterContentFilterError(error)) {
      requestLogger.warn(
        {
          err: error,
          model: error.model,
          status: error.status,
          finishReason: error.finishReason
        },
        "Agent request blocked by OpenRouter content filter"
      );
      const filteredContent = cleanResponse(
        "The model/provider blocked that one, so I’m not going to keep it in channel memory. Try rephrasing it.",
        input.config.maxReplyChars
      );
      const finalReply = (await responseSink.sendError(filteredContent, discordTraceFooter(input.config, request.requestId, request.messageStartedAt))).message;
      await markDiscordDeliveryDelivered(input, agentRuntimeExecution.executionId, finalReply, requestLogger);
      await attachPromptTasksToDiscordReply(input, request.requestId, finalReply, requestLogger);
      const deletedMemoryRows = await input.repo
        .deleteConversationMessagesByDiscordMessageIds({
          threadKey,
          discordMessageIds: [message.id]
        })
        .catch((deleteError) => {
          requestLogger.warn({ err: deleteError }, "Failed to remove content-filtered user turn from channel memory");
          return 0;
        });
      requestLogger.info(
        { replyMessageId: finalReply.id, deletedMemoryRows, durationMs: durationMs(request.messageStartedAt) },
        "Content-filtered Discord mention handled without storing assistant memory"
      );
      await recordTraceEvent(input.repo, {
        eventName: "discord.mention.content_filtered",
        level: "warn",
        summary: "Provider content filter blocked the request",
        metadata: {
          replyMessageId: finalReply.id,
          deletedMemoryRows,
          error: error.message
        },
        durationMs: durationMs(request.messageStartedAt)
      });
      await finishAgentRuntimePromptExecution({
        agentRuntime: input.agentRuntime,
        session: agentRuntimeExecution?.session,
        executionId: agentRuntimeExecution?.executionId,
        traceId: request.requestId,
        status: "failed",
        replyMessageId: finalReply.id,
        replyUrl: finalReply.url,
        responseContent: filteredContent,
        error: error.message,
        durationMs: durationMs(request.messageStartedAt),
        executorName: agentExecutor.name
      }).catch((runtimeError) => requestLogger.warn({ err: runtimeError }, "Failed to mark content-filtered agent runtime execution"));
      return;
    }

    requestLogger.error({ err: error }, "Agent request failed");
    if (isAgentRuntimeTimeoutError(error)) {
      await input.repo
        .auditTool({
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          toolName: "agentError",
          argumentsSummary: request.text,
          error: error.message
        })
        .catch((auditError) => requestLogger.warn({ err: auditError }, "Failed to audit agent timeout"));
    }
    const errorContent = cleanResponse(`I hit an error: ${error instanceof Error ? error.message : String(error)}`, input.config.maxReplyChars);
    const finalReply = (await responseSink.sendError(errorContent, discordTraceFooter(input.config, request.requestId, request.messageStartedAt))).message;
    await markDiscordDeliveryDelivered(input, agentRuntimeExecution.executionId, finalReply, requestLogger);
    await attachPromptTasksToDiscordReply(input, request.requestId, finalReply, requestLogger);
    requestLogger.info({ replyMessageId: finalReply.id }, "Sent Discord error response");
    await recordTraceEvent(input.repo, {
      eventName: "discord.mention.failed",
      level: "error",
      summary: error instanceof Error ? error.message : String(error),
      metadata: { replyMessageId: finalReply.id },
      durationMs: durationMs(request.messageStartedAt)
    });
    await recordAgentRuntimeSpan({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution.session,
      executionId: agentRuntimeExecution.executionId,
      traceId: request.requestId,
      spanId: "agent.request",
      name: "Run model-led agent",
      status: "failed",
      startedAt: new Date(request.messageStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(request.messageStartedAt),
      metadata: {
        executor: agentExecutor.name,
        inputLinesArtifactId: request.inputLinesArtifactId ?? null,
        error: error instanceof Error ? error.message : String(error)
      }
    }).catch((runError) => requestLogger.warn({ err: runError }, "Failed to record failed agent runtime span"));
    await storeAgentRuntimeResponseArtifact({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution.session,
      executionId: agentRuntimeExecution.executionId,
      traceId: request.requestId,
      name: "Discord error response",
      content: errorContent,
      metadata: { replyMessageId: finalReply.id, discordUrl: finalReply.url, error: true }
    }).catch((runError) => requestLogger.warn({ err: runError }, "Failed to store Discord error artifact"));
    await finishAgentRuntimePromptExecution({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution?.session,
      executionId: agentRuntimeExecution?.executionId,
      traceId: request.requestId,
      status: "failed",
      replyMessageId: finalReply.id,
      replyUrl: finalReply.url,
      responseContent: errorContent,
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs(request.messageStartedAt),
      executorName: agentExecutor.name
    }).catch((runtimeError) => requestLogger.warn({ err: runtimeError }, "Failed to mark failed agent runtime execution"));
    await input.repo.appendConversationTurn({
      threadKey,
      turnId: request.requestId,
      user: {
        discordMessageId: message.id,
        authorId: message.author.id,
        authorDisplayName: userDisplayName,
        content: request.text,
        createdAt: message.createdAt,
        metadata: {
          discordUrl: message.url,
          rawContent: request.rawContent,
          attachments: requestAttachments
        }
      },
      assistant: {
        discordMessageId: finalReply.id,
        authorId: client.user?.id ?? null,
        authorDisplayName: client.user?.username ?? null,
        content: errorContent,
        metadata: {
          discordUrl: finalReply.url,
          error: true
        }
      }
    });
    requestLogger.info({ durationMs: durationMs(request.messageStartedAt) }, "Discord mention failed");
  }
}

async function releaseFailedRequestWager(
  input: DiscordAgentRequestInput,
  request: DiscordAgentExecutionRequest,
  error: unknown,
  requestLogger: Logger,
) {
  const explanation = `Agent request failed before wager completion: ${error instanceof Error ? error.message : String(error)}`;
  await input.walletService?.releaseOpenWagerByRequestId(
    request.requestId,
    explanation,
    async (event) => recordTraceEvent(input.repo, {
      ...event,
      metadata: { ...event.metadata, requestId: request.requestId },
    }),
  ).catch((releaseError) => {
    requestLogger.error({ err: releaseError }, "Failed to release wager after agent request failure");
  });
}
