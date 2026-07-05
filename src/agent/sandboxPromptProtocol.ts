import type { ConversationMessage } from "../db/repositories.js";
import type { AgentFile, AgentResponse } from "../tools/types.js";
import type { AgentRuntimeTurnEnvelope } from "./runtimeEnvelope.js";

export type SandboxPromptRequest = {
  envelope: AgentRuntimeTurnEnvelope;
  agentSessionId?: string | null;
  agentExecutionId?: string | null;
  inputLinesArtifactId?: string | null;
  inputLines?: string[];
};

export type SerializedAgentFile = {
  name: string;
  contentType?: string;
  dataBase64: string;
};

export type SandboxPromptResponse = {
  content: string;
  files?: SerializedAgentFile[];
  storedContent?: string;
  memoryEvents?: AgentResponse["memoryEvents"];
};

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

export function serializeAgentResponse(response: AgentResponse): SandboxPromptResponse {
  return {
    content: response.content,
    files: response.files?.map(serializeAgentFile),
    storedContent: response.storedContent,
    memoryEvents: response.memoryEvents
  };
}

export function deserializeAgentResponse(response: SandboxPromptResponse): AgentResponse {
  return {
    content: response.content,
    files: response.files?.map(deserializeAgentFile),
    storedContent: response.storedContent,
    memoryEvents: response.memoryEvents
  };
}

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

function serializeAgentFile(file: AgentFile): SerializedAgentFile {
  return {
    name: file.name,
    contentType: file.contentType,
    dataBase64: file.data.toString("base64")
  };
}

function deserializeAgentFile(file: SerializedAgentFile): AgentFile {
  return {
    name: file.name,
    contentType: file.contentType,
    data: Buffer.from(file.dataBase64, "base64")
  };
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
