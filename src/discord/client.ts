import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Guild,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User
} from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { ConversationMessage, DiscordAiAgentRepository } from "../db/repositories.js";
import { isOpenRouterContentFilterError, type OpenRouterClient } from "../models/openrouter.js";
import { embeddingPriorityForMessageTimestamp, type DiscordAgentRequestJob, type JobRuntime } from "../jobs/queue.js";
import type { DiscordCrawler } from "./crawler.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { visibleChannelIdsForMember } from "./permissions.js";
import { DiscordResponseSink } from "./responseSink.js";
import { isAgentRuntimeTimeoutError } from "../agent/inProcessRuntimeExecutor.js";
import { InProcessAgentRuntimePromptExecutor, type AgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import {
  buildAgentRuntimeTurnEnvelope,
  loadAgentRuntimeTurnEnvelope,
  storeAgentRuntimeTurnEnvelope,
  type AgentRuntimeTurnEnvelope
} from "../agent/runtimeEnvelope.js";
import { ensureAgentRuntimePromptExecution, finishAgentRuntimePromptExecution, type AgentPromptExecutionRef } from "../agent/runtimeLedger.js";
import { enqueueAgentRuntimeSessionExecution, storeAgentRuntimeExecutionInputLines } from "../agent/runtimeControlPlane.js";
import { agentRuntimeInputLinesFromEnvelope, conversationMessagesFromEnvelope } from "../agent/sandboxPromptProtocol.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { DiscordAttachmentContext, DiscordReplyContext, DiscordReplyContextMessage, ToolContext } from "../tools/types.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { runWithTrace, type TraceContext } from "../util/trace.js";
import type { Logger } from "pino";

const SESSION_CONTEXT_MESSAGE_LIMIT = 24;
const REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT = 8;

type DiscordAgentRequestInput = {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  agentExecutor?: AgentRuntimePromptExecutor;
  openRouter: OpenRouterClient;
  jobs?: JobRuntime;
};

type DiscordAgentExecutionRequest = {
  requestId: string;
  agentSessionId?: string;
  agentExecutionId?: string;
  inputLinesArtifactId?: string | null;
  text: string;
  rawContent: string;
  botRoleIds: string[];
  messageStartedAt: number;
  turnEnvelope?: AgentRuntimeTurnEnvelope | null;
};

type PreparedDiscordAgentTurn = {
  turnEnvelope: AgentRuntimeTurnEnvelope;
  turnEnvelopeArtifactId: string | null;
  inputLinesArtifactId: string | null;
  priorSessionMessages: ConversationMessage[];
};

export type DiscordAiAgentBotRuntime = {
  client: Client;
  login: () => Promise<void>;
  drain: (timeoutMs?: number) => Promise<void>;
  destroy: () => void;
};

export function createDiscordAiAgentBot(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  agentExecutor?: AgentRuntimePromptExecutor;
  openRouter: OpenRouterClient;
  crawler: DiscordCrawler;
  jobs?: JobRuntime;
  client?: Client;
}): DiscordAiAgentBotRuntime {
  const client =
    input.client ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });
  let acceptingMessages = true;
  const activeMessageHandlers = new Set<Promise<void>>();

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        tag: readyClient.user.tag,
        userId: readyClient.user.id,
        guildCount: readyClient.guilds.cache.size
      },
      "Discord AI Agent Discord bot is online"
    );
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!acceptingMessages) {
      logger.info({ messageId: message.id, channelId: message.channelId }, "Ignoring Discord message while bot is draining");
      return;
    }
    const handler = runWithTrace(discordMessageTraceContext(message), async () => {
      await handleMessageCreate(input, client, message).catch((error) => {
        logger.error({ err: error, messageId: message.id }, "Message handler failed");
      });
    });
    activeMessageHandlers.add(handler);
    try {
      await handler;
    } finally {
      activeMessageHandlers.delete(handler);
    }
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    await runWithTrace(discordMessageTraceContext(newMessage), async () => {
      try {
        const fetched = newMessage.partial ? await newMessage.fetch() : newMessage;
        if (fetched.inGuild()) {
          if (!shouldProcessGuildEvent(input.config.discord.guildId, fetched.guildId)) return;
          if (isSelfMessage(fetched as Message, client.user?.id)) return;
          await persistDiscordMessage(input.repo, fetched as Message);
          queueIncomingMessageEmbedding(input, fetched as Message, client.user?.id, "message_update");
          await recordTraceEvent(input.repo, { eventName: "discord.message.updated", summary: "Persisted edited Discord message" });
        }
      } catch (error) {
        logger.warn({ err: error }, "Failed to persist message update");
      }
    });
  });

  client.on(Events.MessageDelete, async (message) => {
    await runWithTrace(discordMessageTraceContext(message), async () => {
      if (!shouldProcessGuildEvent(input.config.discord.guildId, message.guildId)) return;
      if (message.id) await input.repo.markMessageDeleted(message.id).catch(() => undefined);
      await recordTraceEvent(input.repo, { eventName: "discord.message.deleted", summary: "Marked Discord message deleted" });
    });
  });

  client.on(Events.MessageBulkDelete, async (messages) => {
    const messageIds = deletedMessageIdsForConfiguredGuild(messages.values(), input.config.discord.guildId);
    await Promise.all(messageIds.map((messageId) => input.repo.markMessageDeleted(messageId).catch(() => undefined)));
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      if (user && !isSelfUser(user, client.user?.id)) {
        const handled = await handleUndoCrossReaction(input, client, reaction, user).catch((error) => {
          logger.warn({ err: error }, "Failed to handle ❌ undo reaction");
          return false;
        });
        if (handled) return;
      }
      await persistReactionMessageUpdate(input, reaction).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction add");
      });
    });
  });

  client.on(Events.MessageReactionRemove, async (reaction) => {
    await runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      await persistReactionMessageUpdate(input, reaction).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction remove");
      });
    });
  });

  client.on(Events.MessageReactionRemoveEmoji, async (reaction) => {
    await runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      await persistReactionMessageUpdate(input, reaction).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction emoji removal");
      });
    });
  });

  client.on(Events.MessageReactionRemoveAll, async (message) => {
    await runWithTrace(discordMessageTraceContext(message), async () => {
      await persistReactionMessage(input, message).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction clear");
      });
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "ai") return;
    await interaction
      .reply({
        content: "Discord AI Agent slash commands are disabled. Mention me with `@ai status` or `@ai tools` instead.",
        flags: MessageFlags.Ephemeral
      })
      .catch((error) => {
        logger.warn({ err: error }, "Failed to reply to stale slash command interaction");
      });
  });

  return {
    client,
    login: async () => {
      if (!input.config.discord.token) throw new Error("DISCORD_TOKEN is required.");
      await client.login(input.config.discord.token);
    },
    drain: async (timeoutMs = 30_000) => {
      acceptingMessages = false;
      if (activeMessageHandlers.size === 0) return;
      logger.info({ activeMessageHandlers: activeMessageHandlers.size, timeoutMs }, "Waiting for active Discord message handlers to drain");
      await waitForActiveHandlers(activeMessageHandlers, timeoutMs);
    },
    destroy: () => {
      acceptingMessages = false;
      client.destroy();
    }
  };
}

async function handleMessageCreate(
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
  await input.repo
    .upsertProcessRun({
      runId: message.id,
      traceId: message.id,
      kind: "discord",
      status: "running",
      title: `Discord mention from ${message.author.username}`,
      summary: previewText(text),
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      messageId: message.id,
      requester: message.member?.displayName ?? message.author.username,
      source: "discord",
      metadata: {
        prompt: text,
        rawContentPreview: previewText(message.content),
        mentionKind: mentionContext.kind ?? "unknown",
        attachmentCount: requestAttachments.length,
        imageAttachmentCount: requestAttachments.filter(isDiscordImageAttachment).length,
        discordUrl: message.url
      },
      links: { discordMessage: message.url }
    })
    .catch((error) => requestLogger.warn({ err: error }, "Failed to create Discord run"));
  await input.repo
    .storeProcessRunArtifact({
      runId: message.id,
      kind: "prompt",
      name: "Discord user prompt",
      content: text,
      contentType: "text/plain",
      metadata: { discordUrl: message.url, rawContent: message.content, attachments: requestAttachments }
    })
    .catch((error) => requestLogger.warn({ err: error }, "Failed to store Discord prompt artifact"));
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
    executorName: input.agentExecutor?.name ?? input.config.agentRuntime.executionBackend
  }).catch((error) => {
    requestLogger.warn({ err: error }, "Failed to record agent runtime prompt session");
    return null;
  });
  const responseSink = new DiscordResponseSink({
    client,
    sourceMessage: message,
    maxReplyChars: input.config.maxReplyChars,
    loadingReactionEmoji: input.config.discord.loadingReaction,
    logger: requestLogger
  });
  await responseSink.acknowledge();
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
      const jobId =
        input.agentRuntime && agentRuntimeExecution
          ? (
              await enqueueAgentRuntimeSessionExecution({
                agentRuntime: input.agentRuntime,
                jobs: input.jobs,
                session: agentRuntimeExecution.session,
                execution: { executionId: agentRuntimeExecution.executionId, traceId: message.id },
                threadKey: agentRuntimeExecution.session.threadKey ?? discordChannelThreadKey(message.guildId, message.channelId),
                queue: queueInput
              })
            ).jobId
          : await input.jobs.enqueueAgentRuntimeExecution({
              ...queueInput,
              agentSessionId: agentRuntimeExecution?.session.sessionId,
              agentExecutionId: agentRuntimeExecution?.executionId,
              agentThreadKey: agentRuntimeExecution?.session.threadKey ?? discordChannelThreadKey(message.guildId, message.channelId)
            });
      await input.repo
        .updateProcessRun({
          runId: message.id,
          status: "queued",
          summary: "Queued Discord mention for worker processing.",
          links: { discordMessage: message.url },
          metadata: {
            pgbossJobId: jobId,
            queuedAt: enqueuedAt.toISOString(),
            acknowledgement: "loading_reaction",
            agentSessionId: agentRuntimeExecution?.session.sessionId ?? null,
            agentExecutionId: agentRuntimeExecution?.executionId ?? null,
            turnEnvelopeArtifactId: preparedTurn.turnEnvelopeArtifactId,
            inputLinesArtifactId: preparedTurn.inputLinesArtifactId
          }
        })
        .catch((error) => requestLogger.warn({ err: error }, "Failed to mark Discord run queued"));
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
      const finalReply = (await responseSink.sendError(errorContent)).message;
      await input.repo
        .updateProcessRun({
          runId: message.id,
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
          links: { discordReply: finalReply.url },
          metadata: { error: error instanceof Error ? error.message : String(error), enqueueFailed: true }
        })
        .catch((runError) => requestLogger.warn({ err: runError }, "Failed to mark Discord enqueue failure"));
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

export const runQueuedDiscordAgentRequest = runQueuedAgentRuntimeExecution;

async function executeDiscordAgentRequest(
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
      statusChannelId: responseSink.statusChannelId,
      statusMessageId: responseSink.statusMessageId,
      updateStatus: async (content) => {
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
      }
    };
    const response = await agentExecutor.execute({
      toolContext,
      text: request.text,
      timeoutMs: input.config.discordAgentResponseTimeoutMs,
      turnEnvelope,
      inputLinesArtifactId: request.inputLinesArtifactId ?? null,
      inputLines
    });
    await input.repo
      .recordProcessRunSpan({
        runId: request.requestId,
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
      })
      .catch((error) => requestLogger.warn({ err: error }, "Failed to record agent span"));

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
    const finalReply = (await responseSink.sendFinal({ content: response.content, files: response.files })).message;
    await attachPromptTasksToDiscordReply(input, request.requestId, finalReply, requestLogger);
    requestLogger.info({ replyMessageId: finalReply.id }, "Sent Discord final response");
    await finishAgentRuntimePromptExecution({
      agentRuntime: input.agentRuntime,
      session: agentRuntimeExecution?.session,
      executionId: agentRuntimeExecution?.executionId,
      traceId: request.requestId,
      status: "succeeded",
      replyMessageId: finalReply.id,
      replyUrl: finalReply.url,
      responseContent: response.content,
      durationMs: durationMs(request.messageStartedAt),
      executorName: agentExecutor.name
    }).catch((error) => requestLogger.warn({ err: error }, "Failed to mark agent runtime execution succeeded"));

    for (const memoryEvent of response.memoryEvents ?? []) {
      await input.repo.appendConversationMessage({
        threadKey,
        role: memoryEvent.role,
        content: memoryEvent.content,
        authorId: client.user?.id ?? null,
        authorDisplayName: client.user?.username ?? null,
        metadata: memoryEvent.metadata
      });
    }
    if (response.memoryEvents?.length) {
      requestLogger.debug({ memoryEventCount: response.memoryEvents.length }, "Stored tool results in channel memory");
    }

    await input.repo.appendConversationMessage({
      threadKey,
      role: "assistant",
      discordMessageId: finalReply.id,
      authorId: client.user?.id ?? null,
      authorDisplayName: client.user?.username ?? null,
      content: response.content,
      metadata: {
        discordUrl: finalReply.url,
        files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
      }
    });
    requestLogger.info({ durationMs: durationMs(request.messageStartedAt) }, "Discord mention handled");
    await recordTraceEvent(input.repo, {
      eventName: "discord.mention.handled",
      summary: "Discord mention handled",
      metadata: { replyMessageId: finalReply.id },
      durationMs: durationMs(request.messageStartedAt)
    });
    await input.repo
      .storeProcessRunArtifact({
        runId: request.requestId,
        kind: "response",
        name: "Discord final response",
        content: response.content,
        contentType: "text/plain",
        metadata: {
          replyMessageId: finalReply.id,
          discordUrl: finalReply.url,
          files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
        }
      })
      .catch((error) => requestLogger.warn({ err: error }, "Failed to store Discord response artifact"));
    await input.repo
      .updateProcessRun({
        runId: request.requestId,
        status: "succeeded",
        summary: `Replied with ${response.content.length} characters.`,
        links: { discordReply: finalReply.url },
        metadata: {
          replyMessageId: finalReply.id,
          durationMs: durationMs(request.messageStartedAt),
          inputLinesArtifactId: request.inputLinesArtifactId ?? null,
          responseChars: response.content.length
        }
      })
      .catch((error) => requestLogger.warn({ err: error }, "Failed to complete Discord run"));
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
      const finalReply = (await responseSink.sendError(filteredContent)).message;
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
      await input.repo
        .updateProcessRun({
          runId: request.requestId,
          status: "failed",
          summary: "Provider content filter blocked the request",
          metadata: { error: error.message, deletedMemoryRows, inputLinesArtifactId: request.inputLinesArtifactId ?? null }
        })
        .catch((runError) => requestLogger.warn({ err: runError }, "Failed to mark content-filtered run"));
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
    const finalReply = (await responseSink.sendError(errorContent)).message;
    await attachPromptTasksToDiscordReply(input, request.requestId, finalReply, requestLogger);
    requestLogger.info({ replyMessageId: finalReply.id }, "Sent Discord error response");
    await recordTraceEvent(input.repo, {
      eventName: "discord.mention.failed",
      level: "error",
      summary: error instanceof Error ? error.message : String(error),
      metadata: { replyMessageId: finalReply.id },
      durationMs: durationMs(request.messageStartedAt)
    });
    await input.repo
      .recordProcessRunSpan({
        runId: request.requestId,
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
      })
      .catch((runError) => requestLogger.warn({ err: runError }, "Failed to record failed agent span"));
    await input.repo
      .storeProcessRunArtifact({
        runId: request.requestId,
        kind: "response",
        name: "Discord error response",
        content: errorContent,
        contentType: "text/plain",
        metadata: { replyMessageId: finalReply.id, error: true }
      })
      .catch((runError) => requestLogger.warn({ err: runError }, "Failed to store Discord error artifact"));
    await input.repo
      .updateProcessRun({
        runId: request.requestId,
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        links: { discordReply: finalReply.url },
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          durationMs: durationMs(request.messageStartedAt),
          inputLinesArtifactId: request.inputLinesArtifactId ?? null
        }
      })
      .catch((runError) => requestLogger.warn({ err: runError }, "Failed to mark Discord run failed"));
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
    await input.repo.appendConversationMessage({
      threadKey,
      role: "assistant",
      discordMessageId: finalReply.id,
      authorId: client.user?.id ?? null,
      authorDisplayName: client.user?.username ?? null,
      content: errorContent,
      metadata: {
        discordUrl: finalReply.url,
        error: true
      }
    });
    requestLogger.info({ durationMs: durationMs(request.messageStartedAt) }, "Discord mention failed");
  }
}

async function prepareDiscordAgentTurn(input: {
  context: DiscordAgentRequestInput;
  client: Client;
  message: Message;
  responseSink: DiscordResponseSink;
  request: DiscordAgentExecutionRequest;
  agentRuntimeExecution: AgentPromptExecutionRef | null;
  requestLogger: Logger;
  source: string;
}): Promise<PreparedDiscordAgentTurn> {
  const guildId = input.message.guildId;
  const guild = input.message.guild;
  if (!guildId || !guild) throw new Error("Discord agent request message is not attached to a guild.");
  const botUserId = input.client.user?.id ?? "";
  const threadKey = discordChannelThreadKey(guildId, input.message.channelId);
  const userDisplayName = input.message.member?.displayName ?? input.message.author.username;
  const requestAttachments = discordAttachmentContextsFromMessage(input.message);
  const sessionStartedAt = Date.now();
  await input.context.repo.ensureConversationSession({
    threadKey,
    guildId,
    channelId: input.message.channelId,
    metadata: {
      kind: "discord_channel",
      channelId: input.message.channelId
    }
  });
  input.requestLogger.debug({ threadKey, source: input.source }, "Ensured conversation session");

  const priorSessionMessages = await input.context.repo.recentConversationMessages({
    threadKey,
    limit: SESSION_CONTEXT_MESSAGE_LIMIT
  });
  input.requestLogger.info(
    {
      threadKey,
      source: input.source,
      sessionMessageCount: priorSessionMessages.length,
      durationMs: durationMs(sessionStartedAt)
    },
    "Loaded channel conversation memory"
  );
  await recordTraceEvent(input.context.repo, {
    eventName: "memory.session.loaded",
    summary: `Loaded ${priorSessionMessages.length} channel memory messages`,
    metadata: { threadKey, source: input.source, sessionMessageCount: priorSessionMessages.length },
    durationMs: durationMs(sessionStartedAt)
  });
  await input.context.repo
    .recordProcessRunSpan({
      runId: input.request.requestId,
      spanId: "memory.session",
      name: "Load channel memory",
      status: "succeeded",
      startedAt: new Date(sessionStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(sessionStartedAt),
      metadata: { threadKey, source: input.source, sessionMessageCount: priorSessionMessages.length }
    })
    .catch((error) => input.requestLogger.warn({ err: error }, "Failed to record memory span"));
  await input.context.repo.appendConversationMessage({
    threadKey,
    role: "user",
    discordMessageId: input.message.id,
    authorId: input.message.author.id,
    authorDisplayName: userDisplayName,
    content: input.request.text,
    createdAt: input.message.createdAt,
    metadata: {
      discordUrl: input.message.url,
      rawContent: input.request.rawContent,
      attachments: requestAttachments
    }
  });
  input.requestLogger.debug({ threadKey, source: input.source }, "Stored user turn in channel memory");

  const permissionStartedAt = Date.now();
  const member = input.message.member ?? (await guild.members.fetch(input.message.author.id));
  const mentionedChannelIds = explicitChannelMentionIds(input.request.rawContent);
  const mentionedUserIds = explicitUserMentionIds(input.request.rawContent, botUserId);
  const referencedChannelId = input.message.reference?.channelId ?? null;
  const visibleChannelIds = await visibleChannelIdsForMember(guild, member, [
    input.message.channelId,
    ...mentionedChannelIds,
    ...(referencedChannelId ? [referencedChannelId] : [])
  ]);
  const replyContext = await resolveDiscordReplyContext({
    repo: input.context.repo,
    message: input.message,
    visibleChannelIds,
    requestLogger: input.requestLogger
  });
  input.requestLogger.info(
    {
      source: input.source,
      visibleChannelCount: visibleChannelIds.length,
      mentionedChannelIds,
      mentionedUserIds,
      replyContextMessageId: replyContext?.messageId,
      durationMs: durationMs(permissionStartedAt)
    },
    "Resolved requester visibility"
  );
  await recordTraceEvent(input.context.repo, {
    eventName: "permissions.visibility.resolved",
    summary: `Resolved ${visibleChannelIds.length} visible channels`,
    metadata: {
      source: input.source,
      visibleChannelCount: visibleChannelIds.length,
      mentionedChannelIds,
      mentionedUserIds,
      replyContextMessageId: replyContext?.messageId
    },
    durationMs: durationMs(permissionStartedAt)
  });
  await input.context.repo
    .recordProcessRunSpan({
      runId: input.request.requestId,
      spanId: "permissions.visibility",
      name: "Resolve Discord permissions",
      status: "succeeded",
      startedAt: new Date(permissionStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(permissionStartedAt),
      metadata: { source: input.source, visibleChannelCount: visibleChannelIds.length, mentionedChannelIds }
    })
    .catch((error) => input.requestLogger.warn({ err: error }, "Failed to record permission span"));

  const turnEnvelope = buildAgentRuntimeTurnEnvelope({
    requestId: input.request.requestId,
    threadKey,
    guildId,
    channelId: input.message.channelId,
    userId: input.message.author.id,
    userDisplayName,
    botUserId,
    botRoleIds: input.request.botRoleIds,
    text: input.request.text,
    rawContent: input.request.rawContent,
    discordUrl: input.message.url,
    messageCreatedAt: input.message.createdAt,
    visibleChannelIds,
    mentionedUserIds,
    mentionedChannelIds,
    replyContext,
    requestAttachments,
    sessionMessages: priorSessionMessages,
    statusChannelId: input.responseSink.statusChannelId,
    statusMessageId: input.responseSink.statusMessageId
  });
  const turnEnvelopeArtifactId = await storeAgentRuntimeTurnEnvelope({
    agentRuntime: input.context.agentRuntime,
    session: input.agentRuntimeExecution?.session,
    executionId: input.agentRuntimeExecution?.executionId,
    envelope: turnEnvelope
  }).catch((error) => {
    input.requestLogger.warn({ err: error }, "Failed to store agent runtime turn envelope");
    return null;
  });
  let inputLinesArtifactId: string | null = null;
  if (input.context.agentRuntime && input.agentRuntimeExecution) {
    const inputLines = agentRuntimeInputLinesFromEnvelope(turnEnvelope);
    inputLinesArtifactId = await storeAgentRuntimeExecutionInputLines({
      agentRuntime: input.context.agentRuntime,
      session: input.agentRuntimeExecution.session,
      execution: { executionId: input.agentRuntimeExecution.executionId, traceId: input.request.requestId },
      inputLines
    }).catch((error) => {
      input.requestLogger.warn({ err: error }, "Failed to store agent runtime input lines");
      return null;
    });
  }
  return {
    turnEnvelope,
    turnEnvelopeArtifactId,
    inputLinesArtifactId,
    priorSessionMessages
  };
}

async function replayPreparedDiscordAgentTurn(input: {
  context: DiscordAgentRequestInput;
  request: DiscordAgentExecutionRequest;
  turnEnvelope: AgentRuntimeTurnEnvelope;
  requestLogger: Logger;
}): Promise<PreparedDiscordAgentTurn> {
  const startedAt = Date.now();
  const priorSessionMessages = conversationMessagesFromEnvelope(input.turnEnvelope);
  input.requestLogger.info(
    {
      threadKey: input.turnEnvelope.threadKey,
      sessionMessageCount: priorSessionMessages.length,
      visibleChannelCount: input.turnEnvelope.visibleChannelIds.length,
      durationMs: durationMs(startedAt)
    },
    "Replayed stored agent turn envelope"
  );
  await recordTraceEvent(input.context.repo, {
    eventName: "agent.execution.context_replayed",
    summary: "Replayed stored agent turn context",
    metadata: {
      threadKey: input.turnEnvelope.threadKey,
      sessionMessageCount: priorSessionMessages.length,
      visibleChannelCount: input.turnEnvelope.visibleChannelIds.length
    },
    durationMs: durationMs(startedAt)
  });
  await input.context.repo
    .recordProcessRunSpan({
      runId: input.request.requestId,
      spanId: "agent.turn_envelope.replay",
      name: "Replay stored turn envelope",
      status: "succeeded",
      startedAt: new Date(startedAt),
      completedAt: new Date(),
      durationMs: durationMs(startedAt),
      metadata: {
        threadKey: input.turnEnvelope.threadKey,
        sessionMessageCount: priorSessionMessages.length,
        visibleChannelCount: input.turnEnvelope.visibleChannelIds.length
      }
    })
    .catch((error) => input.requestLogger.warn({ err: error }, "Failed to record turn envelope replay span"));
  return {
    turnEnvelope: input.turnEnvelope,
    turnEnvelopeArtifactId: null,
    inputLinesArtifactId: input.request.inputLinesArtifactId ?? null,
    priorSessionMessages
  };
}

async function loadAgentRuntimeInputLines(input: {
  agentRuntime?: AgentRuntimeRepository;
  repo: DiscordAiAgentRepository;
  requestId: string;
  artifactId?: string | null;
  requestLogger: Logger;
}): Promise<string[]> {
  if (!input.artifactId) return [];
  const startedAt = Date.now();
  try {
    if (!input.agentRuntime) {
      throw new Error("Agent runtime input lines were requested, but the agent runtime repository is unavailable.");
    }
    const artifact = await input.agentRuntime.getArtifact({ artifactId: input.artifactId });
    if (!artifact) throw new Error(`Agent runtime input lines artifact ${input.artifactId} was not found.`);
    if (artifact.kind !== "input_lines") {
      throw new Error(`Agent runtime artifact ${input.artifactId} is ${artifact.kind}, not input_lines.`);
    }
    const inputLines = artifact.content.split(/\r?\n/).filter((line) => line.length > 0);
    input.requestLogger.info(
      { inputLinesArtifactId: input.artifactId, inputLineCount: inputLines.length, durationMs: durationMs(startedAt) },
      "Loaded agent runtime input lines"
    );
    await input.repo
      .recordProcessRunSpan({
        runId: input.requestId,
        spanId: "agent.input_lines.load",
        name: "Load runtime input lines",
        status: "succeeded",
        startedAt: new Date(startedAt),
        completedAt: new Date(),
        durationMs: durationMs(startedAt),
        metadata: {
          inputLinesArtifactId: input.artifactId,
          inputLineCount: inputLines.length,
          sizeBytes: artifact.sizeBytes
        }
      })
      .catch((error) => input.requestLogger.warn({ err: error }, "Failed to record input-lines load span"));
    return inputLines;
  } catch (error) {
    await input.repo
      .recordProcessRunSpan({
        runId: input.requestId,
        spanId: "agent.input_lines.load",
        name: "Load runtime input lines",
        status: "failed",
        startedAt: new Date(startedAt),
        completedAt: new Date(),
        durationMs: durationMs(startedAt),
        metadata: {
          inputLinesArtifactId: input.artifactId,
          error: error instanceof Error ? error.message : String(error)
        }
      })
      .catch((spanError) => input.requestLogger.warn({ err: spanError }, "Failed to record failed input-lines load span"));
    throw error;
  }
}

async function attachPromptTasksToDiscordReply(
  input: DiscordAgentRequestInput,
  traceId: string,
  finalReply: Message,
  requestLogger: Logger
) {
  const attachedTasks = await input.repo
    .attachAgentTasksToDiscordResponse({
      traceId,
      channelId: finalReply.channelId,
      messageId: finalReply.id
    })
    .catch((error) => {
      requestLogger.warn({ err: error, traceId, replyMessageId: finalReply.id }, "Failed to attach prompt agent tasks to Discord reply");
      return 0;
    });
  if (attachedTasks <= 0) return;
  requestLogger.info({ traceId, replyMessageId: finalReply.id, attachedTasks }, "Attached prompt agent tasks to Discord reply");
  await recordTraceEvent(input.repo, {
    eventName: "agent.tasks.attached_to_reply",
    summary: `Attached ${attachedTasks} agent task${attachedTasks === 1 ? "" : "s"} to the Discord reply`,
    metadata: {
      replyMessageId: finalReply.id,
      replyUrl: finalReply.url,
      attachedTasks
    }
  });
}

function queueIncomingMessageEmbedding(
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

async function resolveDiscordReplyContext(input: {
  repo: DiscordAiAgentRepository;
  message: Message;
  visibleChannelIds: string[];
  requestLogger: Logger;
}): Promise<DiscordReplyContext | undefined> {
  const directFirstChain: DiscordReplyContextMessage[] = [];
  const seenMessageIds = new Set<string>();
  let cursor: Message = input.message;

  for (let depth = 0; depth < REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT; depth += 1) {
    const reference = cursor.reference;
    if (!reference?.messageId) break;
    if (seenMessageIds.has(reference.messageId)) break;

    const referencedChannelId = reference.channelId ?? cursor.channelId;
    if (!input.visibleChannelIds.includes(referencedChannelId)) {
      input.requestLogger.warn(
        { referencedMessageId: reference.messageId, referencedChannelId, depth },
        "Skipping Discord reply context because requester cannot view a referenced channel"
      );
      await recordTraceEvent(input.repo, {
        eventName: "discord.reply_context.skipped",
        level: "warn",
        summary: "Referenced channel is not visible to requester",
        metadata: { referencedMessageId: reference.messageId, referencedChannelId, depth }
      });
      break;
    }

    let parent: Message;
    try {
      parent = await cursor.fetchReference();
    } catch (error) {
      input.requestLogger.warn(
        { err: error, referencedMessageId: reference.messageId, referencedChannelId, depth },
        "Failed to fetch Discord reply chain parent"
      );
      await recordTraceEvent(input.repo, {
        eventName: "discord.reply_context.fetch_failed",
        level: "warn",
        summary: error instanceof Error ? error.message : String(error),
        metadata: { referencedMessageId: reference.messageId, referencedChannelId, depth }
      });
      break;
    }

    if (!parent.inGuild()) break;
    if (!input.visibleChannelIds.includes(parent.channelId)) {
      input.requestLogger.warn(
        { referencedMessageId: parent.id, referencedChannelId: parent.channelId, depth },
        "Stopping Discord reply context chain because requester cannot view the fetched parent channel"
      );
      break;
    }

    await persistDiscordMessage(input.repo, parent).catch((error) => {
      input.requestLogger.warn({ err: error, referencedMessageId: parent.id }, "Failed to persist Discord reply parent message");
    });

    seenMessageIds.add(parent.id);
    directFirstChain.push(discordReplyContextMessageFromMessage(parent));
    cursor = parent;
  }

  if (directFirstChain.length === 0) return undefined;
  const chain = [...directFirstChain].reverse();
  const directParent = directFirstChain[0];
  const rootMessageId = chain[0]?.messageId ?? directParent.messageId;
  const context: DiscordReplyContext = {
    ...directParent,
    rootMessageId,
    chain
  };

  input.requestLogger.info(
    {
      referencedMessageId: context.messageId,
      rootMessageId,
      replyChainLength: chain.length,
      referencedChannelId: context.channelId,
      referencedAuthorId: context.authorId,
      referencedContentPreview: previewText(context.content),
      attachmentCount: context.attachmentSummaries.length
    },
    "Resolved Discord reply chain context"
  );
  await recordTraceEvent(input.repo, {
    eventName: "discord.reply_context.resolved",
    summary: previewText(context.content) || "Resolved Discord reply chain",
    metadata: {
      referencedMessageId: context.messageId,
      rootMessageId,
      replyChainLength: chain.length,
      referencedChannelId: context.channelId,
      referencedAuthorId: context.authorId,
      attachmentCount: context.attachmentSummaries.length
    }
  });
  return context;
}

function discordReplyContextMessageFromMessage(message: Message): DiscordReplyContextMessage {
  const attachments = discordAttachmentContextsFromMessage(message);
  return {
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author?.id ?? null,
    authorDisplayName: message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? null,
    authorIsBot: Boolean(message.author?.bot),
    content: message.content ?? "",
    attachmentSummaries: attachments.map(discordAttachmentSummary),
    attachments,
    createdAt: message.createdAt?.toISOString?.() ?? null,
    url: message.url ?? null
  };
}

function discordAttachmentContextsFromMessage(message: Message): DiscordAttachmentContext[] {
  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    proxyUrl: attachment.proxyURL ?? null,
    filename: attachment.name ?? null,
    contentType: attachment.contentType ?? null,
    sizeBytes: attachment.size ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    description: attachment.description ?? null
  }));
}

function discordAttachmentSummary(attachment: DiscordAttachmentContext) {
  const dimensions = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : "";
  return [attachment.filename ?? attachment.id, attachment.contentType, dimensions, attachment.sizeBytes ? `${attachment.sizeBytes} bytes` : ""]
    .filter(Boolean)
    .join(" ");
}

function isDiscordImageAttachment(attachment: DiscordAttachmentContext) {
  return isImageContentType(attachment.contentType) || /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)$/i.test(attachment.filename ?? "");
}

function isImageContentType(contentType: string | null | undefined) {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("image/");
}

function discordMessageTraceContext(
  message: Pick<Message | PartialMessage, "id" | "guildId" | "channelId"> & {
    author?: { id: string } | null;
  }
): TraceContext {
  return {
    traceId: message.id,
    requestId: message.id,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    userId: message.author?.id,
    messageId: message.id
  };
}

async function recordTraceEvent(
  repo: DiscordAiAgentRepository,
  input: Parameters<DiscordAiAgentRepository["recordTraceEvent"]>[0]
) {
  const recorder = (repo as unknown as { recordTraceEvent?: (event: typeof input) => Promise<void> }).recordTraceEvent;
  if (!recorder) return;
  await recorder.call(repo, input).catch((error) => {
    logger.warn({ err: error, eventName: input.eventName }, "Failed to record trace event");
  });
}

async function waitForActiveHandlers(activeHandlers: Set<Promise<void>>, timeoutMs: number) {
  if (activeHandlers.size === 0) return;
  await Promise.race([
    Promise.allSettled([...activeHandlers]),
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    })
  ]);
}

async function waitForDiscordClientReady(client: Client, timeoutMs = 30_000) {
  if (client.isReady()) return;
  await Promise.race([
    new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve())),
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new TimeoutError(`Discord client was not ready after ${timeoutMs}ms.`)), timeoutMs);
      timeout.unref?.();
    })
  ]);
}

async function fetchDiscordMessage(client: Client, channelId: string, messageId: string): Promise<Message> {
  const channel = await client.channels.fetch(channelId);
  const messages = (channel as any)?.messages;
  if (!messages?.fetch) throw new Error(`Discord channel ${channelId} cannot fetch messages.`);
  return (await messages.fetch(messageId)) as Message;
}

function isTerminalProcessRunStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}

function parseDateMs(value: string | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

async function deleteDiscordMessageById(sourceMessage: Message, messageId: string): Promise<boolean> {
  const messages = (sourceMessage.channel as any).messages;
  if (!messages?.delete) return false;
  try {
    await messages.delete(messageId);
    return true;
  } catch (error) {
    logger.warn({ err: error, messageId }, "Failed to delete undone Discord reply");
    return false;
  }
}

async function persistReactionMessageUpdate(
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

function isSelfUser(user: Pick<User, "id"> | null | undefined, selfUserId?: string | null) {
  return Boolean(selfUserId && user?.id === selfUserId);
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
