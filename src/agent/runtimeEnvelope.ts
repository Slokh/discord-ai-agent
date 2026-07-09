import type { AgentRuntimeRepository, AgentRuntimeSessionRecord } from "../db/agentRuntimeRepository.js";
import type { ConversationMessage } from "../db/repositories.js";
import type { DiscordAttachmentContext, DiscordReplyContext } from "../tools/types.js";

export type AgentRuntimeConversationMessageSnapshot = {
  id: number;
  threadKey: string;
  discordMessageId: string | null;
  role: ConversationMessage["role"];
  authorId: string | null;
  authorDisplayName: string | null;
  content: string;
  parts: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AgentRuntimeTurnEnvelope = {
  schemaVersion: 1;
  source: "discord";
  requestId: string;
  threadKey: string;
  guildId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  botUserId: string | null;
  botRoleIds: string[];
  text: string;
  rawContent: string;
  discordUrl: string;
  messageCreatedAt: string;
  visibleChannelIds: string[];
  mentionedUserIds: string[];
  mentionedChannelIds: string[];
  replyContext: DiscordReplyContext | null;
  requestAttachments: DiscordAttachmentContext[];
  sessionMessages: AgentRuntimeConversationMessageSnapshot[];
  delivery: {
    statusChannelId: string | null;
    statusMessageId: string | null;
  };
  createdAt: string;
};

export function buildAgentRuntimeTurnEnvelope(input: {
  requestId: string;
  threadKey: string;
  guildId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  botUserId?: string | null;
  botRoleIds: string[];
  text: string;
  rawContent: string;
  discordUrl: string;
  messageCreatedAt: Date;
  visibleChannelIds: string[];
  mentionedUserIds: string[];
  mentionedChannelIds: string[];
  replyContext?: DiscordReplyContext | null;
  requestAttachments: DiscordAttachmentContext[];
  sessionMessages: ConversationMessage[];
  statusChannelId?: string | null;
  statusMessageId?: string | null;
  createdAt?: Date;
}): AgentRuntimeTurnEnvelope {
  return {
    schemaVersion: 1,
    source: "discord",
    requestId: input.requestId,
    threadKey: input.threadKey,
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    userDisplayName: input.userDisplayName,
    botUserId: input.botUserId ?? null,
    botRoleIds: input.botRoleIds,
    text: input.text,
    rawContent: input.rawContent,
    discordUrl: input.discordUrl,
    messageCreatedAt: input.messageCreatedAt.toISOString(),
    visibleChannelIds: input.visibleChannelIds,
    mentionedUserIds: input.mentionedUserIds,
    mentionedChannelIds: input.mentionedChannelIds,
    replyContext: input.replyContext ?? null,
    requestAttachments: input.requestAttachments,
    sessionMessages: input.sessionMessages.map(snapshotConversationMessage),
    delivery: {
      statusChannelId: input.statusChannelId ?? null,
      statusMessageId: input.statusMessageId ?? null
    },
    createdAt: (input.createdAt ?? new Date()).toISOString()
  };
}

export async function storeAgentRuntimeTurnEnvelope(input: {
  agentRuntime?: AgentRuntimeRepository;
  session?: AgentRuntimeSessionRecord | null;
  executionId?: string | null;
  envelope: AgentRuntimeTurnEnvelope;
}): Promise<string | null> {
  if (!input.agentRuntime || !input.session || !input.executionId) return null;
  const artifact = await input.agentRuntime.storeArtifact({
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    kind: "turn_envelope",
    name: "Agent runtime turn envelope",
    content: JSON.stringify(input.envelope, null, 2),
    contentType: "application/json",
    metadata: {
      schemaVersion: input.envelope.schemaVersion,
      source: input.envelope.source,
      requestId: input.envelope.requestId,
      guildId: input.envelope.guildId,
      channelId: input.envelope.channelId,
      userId: input.envelope.userId,
      visibleChannelCount: input.envelope.visibleChannelIds.length,
      sessionMessageCount: input.envelope.sessionMessages.length,
      attachmentCount: input.envelope.requestAttachments.length,
      hasReplyContext: Boolean(input.envelope.replyContext)
    }
  });
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    traceId: input.envelope.requestId,
    kind: "artifact",
    eventName: "agent.execution.context_ready",
    summary: "Stored replayable agent turn context.",
    metadata: {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      visibleChannelCount: input.envelope.visibleChannelIds.length,
      sessionMessageCount: input.envelope.sessionMessages.length
    }
  });
  return artifact.artifactId;
}

export async function loadAgentRuntimeTurnEnvelope(input: {
  agentRuntime?: AgentRuntimeRepository;
  artifactId?: string | null;
}): Promise<AgentRuntimeTurnEnvelope | null> {
  if (!input.agentRuntime || !input.artifactId) return null;
  const artifact = await input.agentRuntime.getArtifact({ artifactId: input.artifactId });
  if (!artifact?.content) return null;
  const parsed = JSON.parse(artifact.content) as AgentRuntimeTurnEnvelope;
  if (parsed.schemaVersion !== 1 || parsed.source !== "discord") {
    throw new Error(`Unsupported agent runtime turn envelope artifact: ${input.artifactId}`);
  }
  return parsed;
}

export function replaceAgentRuntimeTurnEnvelopeSessionMessages(
  envelope: AgentRuntimeTurnEnvelope,
  sessionMessages: ConversationMessage[],
  createdAt: Date = new Date()
): AgentRuntimeTurnEnvelope {
  return {
    ...envelope,
    sessionMessages: sessionMessages.map(snapshotConversationMessage),
    createdAt: createdAt.toISOString()
  };
}


type AgentRuntimeInputContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "url";
        url: string;
        media_type?: string;
      };
      metadata?: Record<string, unknown>;
    };

type AgentRuntimeUserInputLine = {
  type: "user";
  thread_key: string;
  message: {
    role: "user";
    content: AgentRuntimeInputContentBlock[];
  };
  metadata: Record<string, unknown>;
};

export function agentRuntimeInputLinesFromEnvelope(envelope: AgentRuntimeTurnEnvelope): string[] {
  const content: AgentRuntimeInputContentBlock[] = [{ type: "text", text: envelope.text }];
  for (const attachment of envelope.requestAttachments) {
    if (!isImageAttachment(attachment)) continue;
    content.push({
      type: "image",
      source: {
        type: "url",
        url: attachment.url,
        media_type: attachment.contentType ?? undefined
      },
      metadata: {
        attachmentId: attachment.id,
        filename: attachment.filename ?? null,
        sizeBytes: attachment.sizeBytes ?? null,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        description: attachment.description ?? null
      }
    });
  }
  const line: AgentRuntimeUserInputLine = {
    type: "user",
    thread_key: envelope.threadKey,
    message: {
      role: "user",
      content
    },
    metadata: {
      source: envelope.source,
      requestId: envelope.requestId,
      discordUrl: envelope.discordUrl,
      guildId: envelope.guildId,
      channelId: envelope.channelId,
      userId: envelope.userId,
      messageCreatedAt: envelope.messageCreatedAt,
      visibleChannelCount: envelope.visibleChannelIds.length,
      mentionedUserIds: envelope.mentionedUserIds,
      mentionedChannelIds: envelope.mentionedChannelIds,
      replyContextMessageId: envelope.replyContext?.messageId ?? null,
      attachmentCount: envelope.requestAttachments.length
    }
  };
  return [JSON.stringify(line)];
}

export function promptTextFromAgentRuntimeInputLines(inputLines: string[] | undefined): string | null {
  if (!inputLines?.length) return null;
  for (const line of [...inputLines].reverse()) {
    const parsed = parseInputLine(line);
    if (!parsed || parsed.type !== "user") continue;
    const content = parsed.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return null;
}

export function conversationMessagesFromEnvelope(envelope: AgentRuntimeTurnEnvelope): ConversationMessage[] {
  return envelope.sessionMessages.map((message) => ({
    id: message.id,
    threadKey: message.threadKey,
    discordMessageId: message.discordMessageId,
    role: message.role,
    authorId: message.authorId,
    authorDisplayName: message.authorDisplayName,
    content: message.content,
    parts: message.parts,
    metadata: message.metadata,
    createdAt: new Date(message.createdAt)
  }));
}

function parseInputLine(line: string): { type?: string; message?: { content?: unknown } } | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as { type?: string; message?: { content?: unknown } }) : null;
  } catch {
    return null;
  }
}

function isImageAttachment(attachment: { contentType?: string | null; filename?: string | null; url: string }) {
  return (
    attachment.contentType?.toLowerCase().startsWith("image/") ||
    /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(attachment.filename ?? attachment.url)
  );
}

function snapshotConversationMessage(message: ConversationMessage): AgentRuntimeConversationMessageSnapshot {
  return {
    id: message.id,
    threadKey: message.threadKey,
    discordMessageId: message.discordMessageId,
    role: message.role,
    authorId: message.authorId,
    authorDisplayName: message.authorDisplayName,
    content: message.content,
    parts: message.parts,
    metadata: message.metadata,
    createdAt: message.createdAt.toISOString()
  };
}
