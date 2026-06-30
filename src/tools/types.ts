import type { AppConfig } from "../config/env.js";
import type { ConversationMessage, DiscordAiAgentRepository } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { JobRuntime } from "../jobs/queue.js";

export type ToolContext = {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
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
  requestId?: string;
  statusChannelId?: string;
  statusMessageId?: string;
  discordRoles?: DiscordRoleSnapshot[];
  deleteDiscordMessageIds?: (messageIds: string[]) => Promise<number>;
  updateStatus?: (content: string) => Promise<void>;
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
  createdAt: string | null;
  url: string | null;
};

export type DiscordReplyContext = DiscordReplyContextMessage & {
  rootMessageId: string;
  chain: DiscordReplyContextMessage[];
};

export type DiscordRoleSnapshot = {
  id: string;
  name: string;
  color?: number | null;
  position?: number | null;
  managed?: boolean;
  memberCount?: number | null;
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
