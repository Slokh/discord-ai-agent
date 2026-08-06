import type { Client, Message } from "discord.js";
import { isOpenRouterContentFilterError } from "../models/openrouter.js";
import type { AgentRuntimeExecutionJob } from "../jobs/queue.js";
import { isAgentRuntimeTimeoutError } from "../agent/runtimeTimeouts.js";
import { NanoCodexAgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import { continuationEvidenceFromResponse } from "../agent/continuationEvidence.js";
import { isInternalControlText } from "../agent/internalControlText.js";
import { agentRuntimeTurnInputText, assertAgentRuntimeTurnEnvelopeScope, loadAgentRuntimeTurnEnvelope } from "../agent/runtimeEnvelope.js";
import { ensureAgentRuntimePromptExecution, finishAgentRuntimePromptExecution } from "../agent/runtimeLedger.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { ToolContext } from "../tools/types.js";
import { durationMs, logger } from "../util/logger.js";
import { addDiscordMessageReaction, createDiscordGuildEmoji, deleteDiscordMessageById, fetchDiscordAttachment, fetchDiscordGuildEmojis, fetchDiscordGuildMembers, fetchDiscordUserAvatar, sendDiscordPollMessage } from "./api.js";
import { discordEmbedContextsFromMessage } from "./embedContext.js";
import { agentExecutionPolicy, discordAgentThreadKey } from "./agentExecutionPolicy.js";
import { DiscordResponseSink } from "./responseSink.js";
import {
  createDiscordDeliveryIntent,
  DISCORD_DELIVERY_INTENT_ARTIFACT_KIND,
  serializeDiscordDeliveryIntent,
} from "./deliveryIntent.js";
import { persistDeliveryFiles, releaseFailedRequestWager } from "./agentDeliveryRecovery.js";
import { deliverDiscordPresentation } from "./presentationDelivery.js";
import { loadAgentRuntimeInputLines, prepareDiscordAgentTurn, replayPreparedDiscordAgentTurn } from "./turnPreparation.js";
import {
  attachPromptTasksToDiscordReply,
  fetchDiscordMessage,
  markDiscordDeliveryDelivered,
  parseDateMs,
  recordAgentRuntimeSpan,
  storeAgentRuntimeResponseArtifact,
  waitForDiscordClientReady,
  type DiscordAgentExecutionRequest,
  type DiscordAgentRequestInput
} from "./requestContext.js";

export type DiscordAgentExecutionResult = {
  status: "succeeded" | "partial" | "failed";
  message: Message;
};

export async function runQueuedAgentRuntimeExecution(
  input: DiscordAgentRequestInput & { client: Client },
  job: AgentRuntimeExecutionJob
) {
  const existingDelivery = job.agentExecutionId
    ? await input.deliveryObligations?.getByExecutionId(job.agentExecutionId).catch(() => undefined)
    : undefined;
  if (existingDelivery?.state === "delivered") {
    logger.info({ runId: job.runId, agentExecutionId: job.agentExecutionId }, "Skipping queued agent runtime execution because Discord delivery already completed");
    return;
  }
  await waitForDiscordClientReady(input.client);

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
  const message = await fetchDiscordMessage(input.client, job.channelId, job.messageId, true);
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
    statusMessage,
    deliveryKey: job.runId
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
    requestEmbeds: discordEmbedContextsFromMessage(message),
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
  const agentExecutor = input.agentExecutor ?? new NanoCodexAgentRuntimePromptExecutor();
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
  const fallbackUserDisplayName = request.userDisplayName ?? message.member?.displayName ?? message.author.username;
  const requesterId = request.userId ?? request.turnEnvelope?.userId ?? message.author.id;
  const requestKind = request.requestKind ?? request.turnEnvelope?.requestKind ?? "message";
  const executionPolicy = agentExecutionPolicy(requestKind);
  const fallbackThreadKey = discordAgentThreadKey({
    requestKind,
    guildId,
    channelId: message.channelId,
    requesterId,
    agentSessionId: request.agentSessionId,
    requestId: request.requestId,
  });
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
    source: `discord.${requestKind}`,
    qualityCohort: executionPolicy.qualityCohort,
    sessionKind: executionPolicy.sessionKind,
    executorName: agentExecutor.name,
    appRevision: input.config.appRevision,
    config: input.config
  }).catch((error) => {
    requestLogger.warn({ err: error }, "Failed to mark agent runtime execution running");
    return null;
  });
  if (!agentRuntimeExecution) {
    const errorContent = "I hit an error: could not create the agent runtime ledger for this turn.";
    const finalReply = (await responseSink.sendError(errorContent, elapsedResponseFooter(request.messageStartedAt))).message;
    return { status: "failed", message: finalReply } satisfies DiscordAgentExecutionResult;
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
  const mentionedUsers = turnEnvelope.mentionedUsers ?? mentionedUserIds.map((userId) => ({
    userId,
    mention: `<@${userId}>`,
    username: null,
    displayName: null,
  }));
  const mentionedChannelIds = turnEnvelope.mentionedChannelIds;
  const replyContext = turnEnvelope.replyContext ?? undefined;
  const requestAttachments = turnEnvelope.requestAttachments;
  const requestEmbeds = turnEnvelope.requestEmbeds ?? [];
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
      mentionedUsers,
      mentionedChannelIds,
      threadKey,
      sessionMessages: priorSessionMessages,
      replyContext,
      requestAttachments,
      requestEmbeds,
      requestId: request.requestId,
      requestMessageId: turnEnvelope.requestId,
      mutationAuthorizedByCurrentInput: executionPolicy.mutationAuthorizedByCurrentInput,
      readOnlyExecution: executionPolicy.readOnlyExecution,
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
      addDiscordReaction: async (reactionInput) => addDiscordMessageReaction(client, turnEnvelope.guildId, reactionInput),
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
        memoryEventCount: response.memoryEvents?.length ?? 0
      }
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to record agent runtime span"));

    requestLogger.info(
      {
        responseChars: response.content.length,
        fileCount: response.files?.length ?? 0,
        memoryEventCount: response.memoryEvents?.length ?? 0
      },
      "Agent response ready"
    );
    const formattedFooter = elapsedResponseFooter(request.messageStartedAt, response.footerLines);
    const storedResponseContent = response.storedContent ?? response.content;
    const responseRedacted = Boolean(response.storedContent);
    const deliveryFileReferences = input.agentRuntime
      ? await persistDeliveryFiles({
          agentRuntime: input.agentRuntime,
          sessionId: agentRuntimeExecution.session.sessionId,
          executionId: agentRuntimeExecution.executionId,
          files: response.files ?? [],
        })
      : [];
    const deliveryIntent = createDiscordDeliveryIntent({
      deliveryKey: request.requestId,
      requesterUserId: turnEnvelope.userId,
      content: response.content,
      storedContent: response.storedContent,
      footer: formattedFooter,
      presentation: response.discordPresentation,
      files: deliveryFileReferences,
    });
    const deliveryIntentArtifactId = input.agentRuntime
      ? await input.agentRuntime.storeArtifact({
          sessionId: agentRuntimeExecution.session.sessionId,
          executionId: agentRuntimeExecution.executionId,
          kind: DISCORD_DELIVERY_INTENT_ARTIFACT_KIND,
          name: "Discord delivery intent",
          content: serializeDiscordDeliveryIntent(deliveryIntent),
          contentType: "application/json",
          metadata: {
            schemaVersion: deliveryIntent.schemaVersion,
            responseRedacted,
            fileCount: deliveryIntent.files.length,
            requestedRichPresentation: Boolean(deliveryIntent.presentation),
          },
        }).then((artifact) => artifact.artifactId).catch((error) => {
          requestLogger.warn({ err: error }, "Failed to persist Discord delivery intent before delivery");
          return null;
        })
      : null;
    if (deliveryIntentArtifactId) {
      await input.agentRuntime?.recordEvent({
        sessionId: agentRuntimeExecution.session.sessionId,
        executionId: agentRuntimeExecution.executionId,
        traceId: request.requestId,
        kind: "artifact",
        eventName: "discord.delivery.intent_stored",
        summary: "Stored recoverable Discord delivery intent before delivery.",
        metadata: { artifactId: deliveryIntentArtifactId, schemaVersion: deliveryIntent.schemaVersion, fileCount: deliveryIntent.files.length },
      }).catch((error) => requestLogger.warn({ err: error }, "Failed to record Discord delivery intent event"));
      await input.deliveryObligations?.upsertPending({
        executionId: agentRuntimeExecution.executionId,
        threadKey,
        guildId: turnEnvelope.guildId,
        channelId: turnEnvelope.channelId,
        statusChannelId: responseSink.statusChannelId,
        statusMessageId: responseSink.statusMessageId,
        sourceMessageId: message.id,
        metadata: { deliveryIntentArtifactId, deliveryIntentSchemaVersion: deliveryIntent.schemaVersion },
      }).catch((error) => requestLogger.warn({ err: error }, "Failed to link Discord delivery intent to obligation"));
    }
    const delivery = await deliverDiscordPresentation({
      responseSink,
      repo: input.repo,
      logger: requestLogger,
      executionId: agentRuntimeExecution.executionId,
      guildId: turnEnvelope.guildId,
      channelId: turnEnvelope.channelId,
      sourceMessageId: message.id,
      requesterUserId: turnEnvelope.userId,
      content: response.content,
      files: response.files,
      footer: formattedFooter,
      presentation: response.discordPresentation,
      premiumSkuIds: input.config.discord.premiumSkuIds,
    });
    const { reply: finalReply, richPresentationDelivered, actionGenerationId, messageCount, continuationMessageIds } = delivery;
    await markDiscordDeliveryDelivered(input, agentRuntimeExecution.executionId, finalReply, requestLogger);
    await attachPromptTasksToDiscordReply(input, request.requestId, finalReply, requestLogger)
      .catch((error) => requestLogger.warn({ err: error, replyMessageId: finalReply.id }, "Failed to reconcile prompt tasks after Discord delivery"));
    requestLogger.info({ replyMessageId: finalReply.id, messageCount, continuationMessageIds }, "Sent Discord final response");
    await finishAgentRuntimePromptExecution({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution?.session,
      executionId: agentRuntimeExecution?.executionId,
      traceId: request.requestId,
      status: "succeeded",
      replyMessageId: finalReply.id,
      replyUrl: finalReply.url,
      responseContent: storedResponseContent,
      responseStatus: response.status ?? "ok",
      durationMs: durationMs(request.messageStartedAt),
      executorName: agentExecutor.name
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to mark agent runtime execution succeeded"));

    if (response.memoryEvents?.length) {
      requestLogger.debug({ memoryEventCount: response.memoryEvents.length }, "Kept tool results in turn memory only");
    }

    if (!isInternalControlText(storedResponseContent)) await input.repo.appendConversationTurn({
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
          attachments: requestAttachments,
          embeds: requestEmbeds
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
          files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? [],
          continuationEvidence: continuationEvidenceFromResponse(response),
        }
      }
    }).catch((error) => requestLogger.warn({ err: error, replyMessageId: finalReply.id }, "Failed to append delivered Discord turn to conversation memory"));
    requestLogger.info({ durationMs: durationMs(request.messageStartedAt) }, "Discord mention handled");
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
        deliveryIntentArtifactId,
        files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
      }
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to store Discord response artifact"));
    return {
      status: response.status === "error" ? "failed" : response.status === "partial" ? "partial" : "succeeded",
      message: finalReply,
    } satisfies DiscordAgentExecutionResult;
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
      const finalReply = (await responseSink.sendError(filteredContent, elapsedResponseFooter(request.messageStartedAt))).message;
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
      await finishAgentRuntimePromptExecution({
        agentRuntime: input.agentRuntime,
        session: agentRuntimeExecution?.session,
        executionId: agentRuntimeExecution?.executionId,
        traceId: request.requestId,
        status: "failed",
        replyMessageId: finalReply.id,
        replyUrl: finalReply.url,
        responseContent: filteredContent,
        responseStatus: "error",
        error: error.message,
        durationMs: durationMs(request.messageStartedAt),
        executorName: agentExecutor.name
      }).catch((runtimeError) => requestLogger.warn({ err: runtimeError }, "Failed to mark content-filtered agent runtime execution"));
      return { status: "failed", message: finalReply } satisfies DiscordAgentExecutionResult;
    }

    requestLogger.error({ err: error }, "Agent request failed");
    if (isAgentRuntimeTimeoutError(error)) {
      await input.repo
        .auditTool({
          guildId: message.guildId,
          channelId: message.channelId,
          userId: requesterId,
          toolName: "agentError",
          argumentsSummary: request.text,
          error: error.message
        })
        .catch((auditError) => requestLogger.warn({ err: auditError }, "Failed to audit agent timeout"));
    }
    const errorContent = cleanResponse(`I hit an error: ${error instanceof Error ? error.message : String(error)}`, input.config.maxReplyChars);
    const finalReply = (await responseSink.sendError(errorContent, elapsedResponseFooter(request.messageStartedAt))).message;
    await markDiscordDeliveryDelivered(input, agentRuntimeExecution.executionId, finalReply, requestLogger);
    await attachPromptTasksToDiscordReply(input, request.requestId, finalReply, requestLogger);
    requestLogger.info({ replyMessageId: finalReply.id }, "Sent Discord error response");
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
      responseStatus: "error",
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs(request.messageStartedAt),
      executorName: agentExecutor.name
    }).catch((runtimeError) => requestLogger.warn({ err: runtimeError }, "Failed to mark failed agent runtime execution"));
    await input.repo.appendConversationTurn({
      threadKey,
      turnId: request.requestId,
      user: {
        discordMessageId: message.id,
        authorId: requesterId,
        authorDisplayName: userDisplayName,
        content: request.text,
        createdAt: message.createdAt,
        metadata: {
          discordUrl: message.url,
          rawContent: request.rawContent,
          attachments: requestAttachments,
          embeds: requestEmbeds
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
    return { status: "failed", message: finalReply } satisfies DiscordAgentExecutionResult;
  }
}

function elapsedResponseFooter(startedAt: number, extraLines?: string[]) {
  return {
    durationMs: durationMs(startedAt),
    ...(extraLines?.length ? { extraLines } : {}),
  };
}
