import type { Client, Message } from "discord.js";
import type { Logger } from "pino";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import {
  agentRuntimeInputLinesFromEnvelope,
  buildAgentRuntimeTurnEnvelope,
  conversationMessagesFromEnvelope,
  replaceAgentRuntimeTurnEnvelopeSessionMessages,
  storeAgentRuntimeTurnEnvelope,
  type AgentRuntimeTurnEnvelope
} from "../agent/runtimeEnvelope.js";
import { storeAgentRuntimeExecutionInputLines } from "../agent/runtimeControlPlane.js";
import type { AgentPromptExecutionRef } from "../agent/runtimeLedger.js";
import type { DiscordReplyContext } from "../tools/types.js";
import { durationMs } from "../util/logger.js";
import { visibleChannelIdsForMember } from "./permissions.js";
import { discordChannelThreadKey, explicitChannelMentionIds, explicitUserMentionIds } from "./mentionParsing.js";
import { discordAttachmentContextsFromMessage, resolveDiscordReplyContext, REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT } from "./replyContext.js";
import type { DiscordResponseSink } from "./responseSink.js";
import {
  recordAgentRuntimeSpan,
  recordTraceEvent,
  type DiscordAgentExecutionRequest,
  type DiscordAgentRequestInput,
  type PreparedDiscordAgentTurn
} from "./requestContext.js";

export const SESSION_CONTEXT_MESSAGE_LIMIT = 8;
export { REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT };

export function sessionContextMessageLimitForReplyContext(replyContext: DiscordReplyContext | null | undefined) {
  return replyContext ? REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT : SESSION_CONTEXT_MESSAGE_LIMIT;
}

export async function prepareDiscordAgentTurn(input: {
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
  if (input.agentRuntimeExecution) {
    await recordAgentRuntimeSpan({
      agentRuntime: input.context.agentRuntime,
      session: input.agentRuntimeExecution.session,
      executionId: input.agentRuntimeExecution.executionId,
      traceId: input.request.requestId,
      spanId: "permissions.visibility",
      name: "Resolve Discord permissions",
      status: "succeeded",
      startedAt: new Date(permissionStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(permissionStartedAt),
      metadata: { source: input.source, visibleChannelCount: visibleChannelIds.length, mentionedChannelIds }
    }).catch((error) => input.requestLogger.warn({ err: error }, "Failed to record permission span"));
  }

  const sessionStartedAt = Date.now();
  const sessionContextLimit = sessionContextMessageLimitForReplyContext(replyContext);
  const priorSessionMessages = await input.context.repo.recentConversationMessages({
    threadKey,
    limit: sessionContextLimit
  });
  input.requestLogger.info(
    {
      threadKey,
      source: input.source,
      sessionMessageCount: priorSessionMessages.length,
      sessionContextLimit,
      hasReplyContext: Boolean(replyContext),
      durationMs: durationMs(sessionStartedAt)
    },
    "Loaded channel conversation memory"
  );
  await recordTraceEvent(input.context.repo, {
    eventName: "memory.session.loaded",
    summary: `Loaded ${priorSessionMessages.length} channel memory messages`,
    metadata: { threadKey, source: input.source, sessionMessageCount: priorSessionMessages.length, sessionContextLimit, hasReplyContext: Boolean(replyContext) },
    durationMs: durationMs(sessionStartedAt)
  });
  if (input.agentRuntimeExecution) {
    await recordAgentRuntimeSpan({
      agentRuntime: input.context.agentRuntime,
      session: input.agentRuntimeExecution.session,
      executionId: input.agentRuntimeExecution.executionId,
      traceId: input.request.requestId,
      spanId: "memory.session",
      name: "Load channel memory",
      status: "succeeded",
      startedAt: new Date(sessionStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(sessionStartedAt),
      metadata: { threadKey, source: input.source, sessionMessageCount: priorSessionMessages.length, sessionContextLimit, hasReplyContext: Boolean(replyContext) }
    }).catch((error) => input.requestLogger.warn({ err: error }, "Failed to record memory span"));
  }

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

export async function replayPreparedDiscordAgentTurn(input: {
  context: DiscordAgentRequestInput;
  request: DiscordAgentExecutionRequest;
  turnEnvelope: AgentRuntimeTurnEnvelope;
  requestLogger: Logger;
}): Promise<PreparedDiscordAgentTurn> {
  const startedAt = Date.now();
  let priorSessionMessages = conversationMessagesFromEnvelope(input.turnEnvelope);
  let turnEnvelope = input.turnEnvelope;
  let refreshed = false;
  try {
    const sessionContextLimit = sessionContextMessageLimitForReplyContext(input.turnEnvelope.replyContext);
    priorSessionMessages = await input.context.repo.recentConversationMessages({
      threadKey: input.turnEnvelope.threadKey,
      limit: sessionContextLimit
    });
    turnEnvelope = replaceAgentRuntimeTurnEnvelopeSessionMessages(input.turnEnvelope, priorSessionMessages);
    refreshed = true;
  } catch (error) {
    input.requestLogger.warn({ err: error, threadKey: input.turnEnvelope.threadKey }, "Failed to refresh queued channel memory; using stored envelope memory");
  }
  input.requestLogger.info(
    {
      threadKey: turnEnvelope.threadKey,
      sessionMessageCount: priorSessionMessages.length,
      staleSessionMessageCount: input.turnEnvelope.sessionMessages.length,
      visibleChannelCount: turnEnvelope.visibleChannelIds.length,
      refreshed,
      durationMs: durationMs(startedAt)
    },
    refreshed ? "Refreshed queued agent turn memory" : "Replayed stored agent turn envelope"
  );
  await recordTraceEvent(input.context.repo, {
    eventName: "agent.execution.context_replayed",
    summary: refreshed ? "Refreshed queued agent turn context" : "Replayed stored agent turn context",
    metadata: {
      threadKey: turnEnvelope.threadKey,
      sessionMessageCount: priorSessionMessages.length,
      staleSessionMessageCount: input.turnEnvelope.sessionMessages.length,
      visibleChannelCount: turnEnvelope.visibleChannelIds.length,
      refreshed
    },
    durationMs: durationMs(startedAt)
  });
  return {
    turnEnvelope,
    turnEnvelopeArtifactId: null,
    inputLinesArtifactId: input.request.inputLinesArtifactId ?? null,
    priorSessionMessages
  };
}

export async function loadAgentRuntimeInputLines(input: {
  agentRuntime?: AgentRuntimeRepository;
  repo: DiscordAiAgentRepository;
  requestId: string;
  artifactId?: string | null;
  requestLogger: Logger;
  runtimeExecution?: AgentPromptExecutionRef | null;
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
    if (input.runtimeExecution) {
      await recordAgentRuntimeSpan({
        agentRuntime: input.agentRuntime,
        session: input.runtimeExecution.session,
        executionId: input.runtimeExecution.executionId,
        traceId: input.requestId,
        spanId: "agent.input_lines.load",
        name: "Load runtime input lines",
        status: "succeeded",
        startedAt: new Date(startedAt),
        completedAt: new Date(),
        durationMs: durationMs(startedAt),
        metadata: { inputLinesArtifactId: input.artifactId, inputLineCount: inputLines.length, sizeBytes: artifact.sizeBytes }
      }).catch((error) => input.requestLogger.warn({ err: error }, "Failed to record input-lines load span"));
    }
    return inputLines;
  } catch (error) {
    if (input.runtimeExecution) {
      await recordAgentRuntimeSpan({
        agentRuntime: input.agentRuntime,
        session: input.runtimeExecution.session,
        executionId: input.runtimeExecution.executionId,
        traceId: input.requestId,
        spanId: "agent.input_lines.load",
        name: "Load runtime input lines",
        status: "failed",
        startedAt: new Date(startedAt),
        completedAt: new Date(),
        durationMs: durationMs(startedAt),
        metadata: { inputLinesArtifactId: input.artifactId, error: error instanceof Error ? error.message : String(error) }
      }).catch((spanError) => input.requestLogger.warn({ err: spanError }, "Failed to record failed input-lines load span"));
    }
    throw error;
  }
}
