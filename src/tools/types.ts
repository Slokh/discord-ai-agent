import type { AppConfig } from "../config/env.js";
import type { ConversationMessage, DiscordAiAgentRepository } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { GitHubSkillClient } from "../skills/github.js";

export type ToolContext = {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  github: GitHubSkillClient;
  guildId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  visibleChannelIds: string[];
  mentionedUserIds?: string[];
  mentionedChannelIds?: string[];
  threadKey?: string;
  sessionMessages?: ConversationMessage[];
  requestId?: string;
  discordRoles?: DiscordRoleSnapshot[];
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
