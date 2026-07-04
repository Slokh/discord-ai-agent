import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository, AgentRuntimeSessionRecord } from "../db/agentRuntimeRepository.js";
import type { ConversationMessage, DiscordAiAgentRepository } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { JobRuntime } from "../jobs/queue.js";

export type ToolContext = {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  agentRuntimeSession?: AgentRuntimeSessionRecord | null;
  agentRuntimeExecutionId?: string | null;
  openRouter: OpenRouterClient;
  jobs?: JobRuntime;
  guildId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  visibleChannelIds: string[];
  mentionedUserIds?: string[];
  mentionedChannelIds?: string[];
  threadKey?: string;
  sessionMessages?: ConversationMessage[];
  replyContext?: DiscordReplyContext;
  requestAttachments?: DiscordAttachmentContext[];
  requestId?: string;
  statusChannelId?: string;
  statusMessageId?: string;
  visibleIndexedChannelIds?: string[];
  deleteDiscordMessageIds?: (messageIds: string[]) => Promise<number>;
  updateStatus?: (content: string) => Promise<void>;
};

export type DiscordAttachmentContext = {
  id: string;
  url: string;
  proxyUrl?: string | null;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  description?: string | null;
};

export type DiscordReplyContextMessage = {
  messageId: string;
  channelId: string;
  guildId: string | null;
  authorId: string | null;
  authorDisplayName: string | null;
  authorIsBot: boolean;
  content: string;
  attachmentSummaries: string[];
  attachments: DiscordAttachmentContext[];
  createdAt: string | null;
  url: string | null;
};

export type DiscordReplyContext = DiscordReplyContextMessage & {
  rootMessageId: string;
  chain: DiscordReplyContextMessage[];
};

export type AgentFile = {
  name: string;
  data: Buffer;
  contentType?: string;
};

export type AgentResponse = {
  content: string;
  files?: AgentFile[];
  memoryEvents?: Array<{
    role: "tool";
    content: string;
    metadata?: Record<string, unknown>;
  }>;
};
