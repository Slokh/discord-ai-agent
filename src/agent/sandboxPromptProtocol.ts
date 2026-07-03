import type { ConversationMessage } from "../db/repositories.js";
import type { AgentFile, AgentResponse } from "../tools/types.js";
import type { AgentRuntimeTurnEnvelope } from "./runtimeEnvelope.js";

export type SandboxPromptRequest = {
  envelope: AgentRuntimeTurnEnvelope;
};

export type SerializedAgentFile = {
  name: string;
  contentType?: string;
  dataBase64: string;
};

export type SandboxPromptResponse = {
  content: string;
  files?: SerializedAgentFile[];
  memoryEvents?: AgentResponse["memoryEvents"];
};

export function serializeAgentResponse(response: AgentResponse): SandboxPromptResponse {
  return {
    content: response.content,
    files: response.files?.map(serializeAgentFile),
    memoryEvents: response.memoryEvents
  };
}

export function deserializeAgentResponse(response: SandboxPromptResponse): AgentResponse {
  return {
    content: response.content,
    files: response.files?.map(deserializeAgentFile),
    memoryEvents: response.memoryEvents
  };
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
