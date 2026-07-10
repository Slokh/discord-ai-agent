import type { Client, Message } from "discord.js";
import { isOpenRouterContentFilterError } from "../models/openrouter.js";
import type { DiscordAgentRequestJob } from "../jobs/queue.js";
import { isAgentRuntimeTimeoutError } from "../agent/inProcessRuntimeExecutor.js";
import { InProcessAgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import { loadAgentRuntimeTurnEnvelope } from "../agent/runtimeEnvelope.js";
import { ensureAgentRuntimePromptExecution, finishAgentRuntimePromptExecution } from "../agent/runtimeLedger.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { ToolContext } from "../tools/types.js";
import { durationMs, logger } from "../util/logger.js";
import { deleteDiscordMessageById, fetchDiscordUserAvatar, sendDiscordPollMessage } from "./api.js";
import { discordChannelThreadKey } from "./mentionParsing.js";
import { DiscordResponseSink } from "./responseSink.js";
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
  await responseSink.acknowledge();
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
    turnEnvelope
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
    userId: message.author.id,
    inputLinesArtifactId: request.inputLinesArtifactId ?? null
  });
  const fallbackThreadKey = discordChannelThreadKey(guildId, message.channelId);
  const fallbackUserDisplayName = message.member?.displayName ?? message.author.username;
  const agentRuntimeExecution = await ensureAgentRuntimePromptExecution({
    agentRuntime: input.agentRuntime,
    guildId,
    channelId: message.channelId,
    userId: message.author.id,
    userDisplayName: fallbackUserDisplayName,
    threadKey: request.turnEnvelope?.threadKey ?? fallbackThreadKey,
    agentSessionId: request.agentSessionId,
    agentExecutionId: request.agentExecutionId,
    requestId: request.requestId,
    text: request.text,
    rawContent: request.rawContent,
    discordUrl: message.url,
    status: "running",
    source: "discord.worker",
    executorName: agentExecutor.name
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
    const agentStartedAt = Date.now();
    const inputLines = await loadAgentRuntimeInputLines({
      agentRuntime: input.agentRuntime,
      repo: input.repo,
      requestId: request.requestId,
      artifactId: request.inputLinesArtifactId,
      requestLogger
    });
    const toolContext: ToolContext = {
      config: input.config,
      repo: input.repo,
      budgetRepo: input.budgetRepo,
      rngRepo: input.rngRepo,
      agentRuntime: input.agentRuntime,
      agentRuntimeSession: agentRuntimeExecution?.session ?? null,
      agentRuntimeExecutionId: agentRuntimeExecution?.executionId ?? null,
      openRouter: input.openRouter,
      jobs: input.jobs,
      guildId: turnEnvelope.guildId,
      channelId: turnEnvelope.channelId,
      userId: turnEnvelope.userId,
      userDisplayName,
      visibleChannelIds,
      mentionedUserIds,
      mentionedChannelIds,
      threadKey,
      sessionMessages: priorSessionMessages,
      replyContext,
      requestAttachments,
      requestId: request.requestId,
      requestMessageId: message.id,
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
      fetchDiscordUserAvatar: async ({ userId }) => fetchDiscordUserAvatar(client, turnEnvelope.guildId, userId)
    };
    const response = await agentExecutor.execute({
      toolContext,
      text: request.text,
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
    await recordTraceEvent(input.repo, {
      eventName: "agent.response.ready",
      summary: `Agent returned ${response.content.length} chars`,
      metadata: {
        executor: agentExecutor.name,
        inputLinesArtifactId: request.inputLinesArtifactId ?? null,
        responseChars: response.content.length,
        fileCount: response.files?.length ?? 0,
        memoryEventCount: response.memoryEvents?.length ?? 0
      }
    });
    const traceFooter = discordTraceFooter(input.config, request.requestId, request.messageStartedAt);
    const finalReply = (
      await responseSink.sendFinal({
        content: response.content,
        files: response.files,
        footer: response.footerLines?.length ? { ...traceFooter, extraLines: response.footerLines } : traceFooter
      })
    ).message;
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
        content: storedResponseContent,
        metadata: {
          discordUrl: finalReply.url,
          responseRedacted,
          files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
        }
      }
    });
    requestLogger.info({ durationMs: durationMs(request.messageStartedAt) }, "Discord mention handled");
    await recordTraceEvent(input.repo, {
      eventName: "discord.mention.handled",
      summary: "Discord mention handled",
      metadata: { replyMessageId: finalReply.id },
      durationMs: durationMs(request.messageStartedAt)
    });
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
        files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
      }
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to store Discord response artifact"));
  } catch (error) {
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
