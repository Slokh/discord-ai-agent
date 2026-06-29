import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Guild,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction
} from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { isOpenRouterContentFilterError, type OpenRouterClient } from "../models/openrouter.js";
import type { GitHubSkillClient } from "../skills/github.js";
import { embeddingPriorityForMessageTimestamp, type JobRuntime } from "../jobs/queue.js";
import type { DiscordCrawler } from "./crawler.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { visibleChannelIdsForMember } from "./permissions.js";
import { handleAgentRequest } from "../agent/router.js";
import { cleanResponse } from "../tools/coreTools.js";
import type { DiscordReplyContext } from "../tools/types.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { chunkForDiscord } from "../util/text.js";
import { runWithTrace, type TraceContext } from "../util/trace.js";
import type { Logger } from "pino";

const SESSION_CONTEXT_MESSAGE_LIMIT = 24;
const DISCORD_AGENT_RESPONSE_TIMEOUT_MS = 30 * 60 * 1000;

export type DiscordAiAgentBotRuntime = {
  client: Client;
  login: () => Promise<void>;
  destroy: () => void;
};

export function createDiscordAiAgentBot(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  github: GitHubSkillClient;
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
    await runWithTrace(discordMessageTraceContext(message), async () => {
      await handleMessageCreate(input, client, message).catch((error) => {
        logger.error({ err: error, messageId: message.id }, "Message handler failed");
      });
    });
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

  client.on(Events.MessageReactionAdd, async (reaction) => {
    await runWithTrace(discordMessageTraceContext(reaction.message), async () => {
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
    destroy: () => client.destroy()
  };
}

async function handleMessageCreate(
  input: {
    config: AppConfig;
    repo: DiscordAiAgentRepository;
    openRouter: OpenRouterClient;
    github: GitHubSkillClient;
    jobs?: JobRuntime;
  },
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
        mentionKind: mentionContext.kind,
        botRoleIds: mentionContext.botRoleIds
      },
      "Ignoring Discord AI Agent mention from interaction-blocked user"
    );
    return;
  }

  const requestId = message.id;
  const text = stripBotAddress(message.content, client.user.id, mentionContext.botRoleIds).trim();
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
      botRoleIds: mentionContext.botRoleIds
    },
    "Discord AI Agent mention received"
  );
  await recordTraceEvent(input.repo, {
    eventName: "discord.mention.received",
    summary: previewText(text),
    metadata: {
      rawContentPreview: previewText(message.content),
      mentionKind: mentionContext.kind
    }
  });
  const thinking = await message.reply("Thinking...");
  requestLogger.debug({ replyMessageId: thinking.id }, "Sent thinking reply");
  await recordTraceEvent(input.repo, {
    eventName: "discord.thinking.sent",
    summary: "Sent Thinking reply",
    metadata: { replyMessageId: thinking.id }
  });
  const threadKey = discordChannelThreadKey(message.guildId, message.channelId);
  const userDisplayName = message.member?.displayName ?? message.author.username;
  const sessionStartedAt = Date.now();
  await input.repo.ensureConversationSession({
    threadKey,
    guildId: message.guildId,
    channelId: message.channelId,
    metadata: {
      kind: "discord_channel",
      channelId: message.channelId
    }
  });
  requestLogger.debug({ threadKey }, "Ensured conversation session");

  const priorSessionMessages = await input.repo.recentConversationMessages({
    threadKey,
    limit: SESSION_CONTEXT_MESSAGE_LIMIT
  });
  requestLogger.info(
    {
      threadKey,
      sessionMessageCount: priorSessionMessages.length,
      durationMs: durationMs(sessionStartedAt)
    },
    "Loaded channel conversation memory"
  );
  await recordTraceEvent(input.repo, {
    eventName: "memory.session.loaded",
    summary: `Loaded ${priorSessionMessages.length} channel memory messages`,
    metadata: { threadKey, sessionMessageCount: priorSessionMessages.length },
    durationMs: durationMs(sessionStartedAt)
  });
  await input.repo.appendConversationMessage({
    threadKey,
    role: "user",
    discordMessageId: message.id,
    authorId: message.author.id,
    authorDisplayName: userDisplayName,
    content: text,
    createdAt: message.createdAt,
    metadata: {
      discordUrl: message.url,
      rawContent: message.content
    }
  });
  requestLogger.debug({ threadKey }, "Stored user turn in channel memory");

  const permissionStartedAt = Date.now();
  const member = message.member ?? (await message.guild.members.fetch(message.author.id));
  const mentionedChannelIds = explicitChannelMentionIds(message.content);
  const referencedChannelId = message.reference?.channelId ?? null;
  const visibleChannelIds = await visibleChannelIdsForMember(message.guild, member, [
    message.channelId,
    ...mentionedChannelIds,
    ...(referencedChannelId ? [referencedChannelId] : [])
  ]);
  const replyContext = await resolveDiscordReplyContext({
    repo: input.repo,
    message,
    visibleChannelIds,
    requestLogger
  });
  requestLogger.info(
    {
      visibleChannelCount: visibleChannelIds.length,
      mentionedChannelIds,
      mentionedUserIds: explicitUserMentionIds(message.content, client.user.id),
      replyContextMessageId: replyContext?.messageId,
      durationMs: durationMs(permissionStartedAt)
    },
    "Resolved requester visibility"
  );
  await recordTraceEvent(input.repo, {
    eventName: "permissions.visibility.resolved",
    summary: `Resolved ${visibleChannelIds.length} visible channels`,
    metadata: {
      visibleChannelCount: visibleChannelIds.length,
      mentionedChannelIds,
      mentionedUserIds: explicitUserMentionIds(message.content, client.user.id),
      replyContextMessageId: replyContext?.messageId
    },
    durationMs: durationMs(permissionStartedAt)
  });

  try {
    const response = await withTimeout(
      handleAgentRequest(
        {
          config: input.config,
          repo: input.repo,
          openRouter: input.openRouter,
          github: input.github,
          jobs: input.jobs,
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          userDisplayName,
          visibleChannelIds,
          mentionedUserIds: explicitUserMentionIds(message.content, client.user.id),
          mentionedChannelIds,
          threadKey,
          sessionMessages: priorSessionMessages,
          replyContext,
          requestId,
          discordRoles: discordRoleSnapshots(message.guild),
          updateStatus: async (content) => {
            await thinking.edit(cleanResponse(content, input.config.maxReplyChars));
          },
          deleteDiscordMessageIds: async (messageIds) => {
            let deleted = 0;
            for (const messageId of messageIds) {
              if (await deleteDiscordMessageById(message, messageId)) deleted += 1;
            }
            return deleted;
          }
        },
        text
      ),
      DISCORD_AGENT_RESPONSE_TIMEOUT_MS,
      "Discord AI Agent agent request"
    );

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
        responseChars: response.content.length,
        fileCount: response.files?.length ?? 0,
        memoryEventCount: response.memoryEvents?.length ?? 0
      }
    });
    const replyChunks = chunkForDiscord(response.content, input.config.maxReplyChars);
    const attachments = response.files?.map((file) => new AttachmentBuilder(file.data, { name: file.name }));
    const finalReply = await sendChunkedReply(thinking, message, replyChunks, attachments);
    requestLogger.info({ replyMessageId: finalReply.id, chunkCount: replyChunks.length }, "Edited Discord reply with final response");

    for (const memoryEvent of response.memoryEvents ?? []) {
      await input.repo.appendConversationMessage({
        threadKey,
        role: memoryEvent.role,
        content: memoryEvent.content,
        authorId: client.user.id,
        authorDisplayName: client.user.username,
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
      authorId: client.user.id,
      authorDisplayName: client.user.username,
      content: response.content,
      metadata: {
        discordUrl: finalReply.url,
        files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
      }
    });
    requestLogger.info({ durationMs: durationMs(messageStartedAt) }, "Discord mention handled");
    await recordTraceEvent(input.repo, {
      eventName: "discord.mention.handled",
      summary: "Discord mention handled",
      metadata: { replyMessageId: finalReply.id },
      durationMs: durationMs(messageStartedAt)
    });
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
      const finalReply = await thinking.edit(filteredContent);
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
        { replyMessageId: finalReply.id, deletedMemoryRows, durationMs: durationMs(messageStartedAt) },
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
        durationMs: durationMs(messageStartedAt)
      });
      return;
    }

    requestLogger.error({ err: error }, "Agent request failed");
    if (isTimeoutError(error)) {
      await input.repo
        .auditTool({
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          toolName: "agentError",
          argumentsSummary: text,
          error: error.message
        })
        .catch((auditError) => requestLogger.warn({ err: auditError }, "Failed to audit agent timeout"));
    }
    const errorContent = cleanResponse(`I hit an error: ${error instanceof Error ? error.message : String(error)}`, input.config.maxReplyChars);
    const finalReply = await thinking.edit(errorContent);
    requestLogger.info({ replyMessageId: finalReply.id }, "Edited Discord reply with error response");
    await recordTraceEvent(input.repo, {
      eventName: "discord.mention.failed",
      level: "error",
      summary: error instanceof Error ? error.message : String(error),
      metadata: { replyMessageId: finalReply.id },
      durationMs: durationMs(messageStartedAt)
    });
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
    requestLogger.info({ durationMs: durationMs(messageStartedAt) }, "Discord mention failed");
  }
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
  const reference = input.message.reference;
  if (!reference?.messageId) return undefined;

  const referencedChannelId = reference.channelId ?? input.message.channelId;
  if (!input.visibleChannelIds.includes(referencedChannelId)) {
    input.requestLogger.warn(
      { referencedMessageId: reference.messageId, referencedChannelId },
      "Skipping Discord reply context because requester cannot view the referenced channel"
    );
    await recordTraceEvent(input.repo, {
      eventName: "discord.reply_context.skipped",
      level: "warn",
      summary: "Referenced channel is not visible to requester",
      metadata: { referencedMessageId: reference.messageId, referencedChannelId }
    });
    return undefined;
  }

  try {
    const parent = await input.message.fetchReference();
    if (!parent.inGuild()) return undefined;
    if (!input.visibleChannelIds.includes(parent.channelId)) {
      input.requestLogger.warn(
        { referencedMessageId: parent.id, referencedChannelId: parent.channelId },
        "Skipping Discord reply context after fetch because requester cannot view the parent channel"
      );
      return undefined;
    }

    await persistDiscordMessage(input.repo, parent).catch((error) => {
      input.requestLogger.warn({ err: error, referencedMessageId: parent.id }, "Failed to persist Discord reply parent message");
    });

    const context: DiscordReplyContext = {
      messageId: parent.id,
      channelId: parent.channelId,
      guildId: parent.guildId,
      authorId: parent.author?.id ?? null,
      authorDisplayName: parent.member?.displayName ?? parent.author?.globalName ?? parent.author?.username ?? null,
      authorIsBot: Boolean(parent.author?.bot),
      content: parent.content ?? "",
      attachmentSummaries: [...parent.attachments.values()].map((attachment) =>
        [attachment.name ?? attachment.id, attachment.contentType, attachment.size ? `${attachment.size} bytes` : ""].filter(Boolean).join(" ")
      ),
      createdAt: parent.createdAt?.toISOString?.() ?? null,
      url: parent.url ?? null
    };

    input.requestLogger.info(
      {
        referencedMessageId: context.messageId,
        referencedChannelId: context.channelId,
        referencedAuthorId: context.authorId,
        referencedContentPreview: previewText(context.content),
        attachmentCount: context.attachmentSummaries.length
      },
      "Resolved Discord reply parent context"
    );
    await recordTraceEvent(input.repo, {
      eventName: "discord.reply_context.resolved",
      summary: previewText(context.content) || "Resolved Discord reply parent",
      metadata: {
        referencedMessageId: context.messageId,
        referencedChannelId: context.channelId,
        referencedAuthorId: context.authorId,
        attachmentCount: context.attachmentSummaries.length
      }
    });
    return context;
  } catch (error) {
    input.requestLogger.warn({ err: error, referencedMessageId: reference.messageId, referencedChannelId }, "Failed to fetch Discord reply parent");
    await recordTraceEvent(input.repo, {
      eventName: "discord.reply_context.fetch_failed",
      level: "warn",
      summary: error instanceof Error ? error.message : String(error),
      metadata: { referencedMessageId: reference.messageId, referencedChannelId }
    });
    return undefined;
  }
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

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Sends an agent response that may exceed Discord's 2000-character message limit
 * as multiple sequential messages. The first chunk replaces the "Thinking..."
 * placeholder reply; subsequent chunks are sent as follow-up messages in the same
 * channel. Attachments are only attached to the first message.
 */
export async function sendChunkedReply(
  thinking: Message,
  sourceMessage: Message,
  chunks: string[],
  attachments?: AttachmentBuilder[]
): Promise<Message> {
  if (chunks.length <= 1) {
    return thinking.edit({
      content: chunks[0] ?? "",
      files: attachments
    }) as Promise<Message>;
  }

  const firstReply = (await thinking.edit({
    content: chunks[0],
    files: attachments
  })) as Message;

  const channel = sourceMessage.channel;
  if (typeof (channel as { send?: unknown }).send !== "function") return firstReply;

  const send = (channel as { send: (content: string) => Promise<Message> }).send;
  let lastMessage = firstReply;
  for (let i = 1; i < chunks.length; i++) {
    lastMessage = await send(chunks[i]);
  }
  return lastMessage;
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

async function resolveBotMentionContext(
  message: Message,
  botUserId: string
): Promise<{ addressed: boolean; kind: "user" | "role" | null; botRoleIds: string[] }> {
  if (hasExplicitBotMention(message.content, botUserId)) {
    return { addressed: true, kind: "user", botRoleIds: [] };
  }

  const mentionedRoleIds = explicitRoleMentionIds(message.content);
  if (mentionedRoleIds.length === 0) {
    return { addressed: false, kind: null, botRoleIds: [] };
  }

  const botRoleIds = await botManagedRoleIds(message.guild, botUserId);
  return {
    addressed: mentionedRoleIds.some((roleId) => botRoleIds.includes(roleId)),
    kind: "role",
    botRoleIds
  };
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

function discordRoleSnapshots(guild: Guild | null) {
  if (!guild) return [];
  return [...guild.roles.cache.values()].map((role) => ({
    id: role.id,
    name: role.name,
    color: role.color,
    position: role.position,
    managed: role.managed,
    memberCount: role.members.size
  }));
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
