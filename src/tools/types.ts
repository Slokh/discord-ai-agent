import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository, AgentRuntimeSessionRecord } from "../db/agentRuntimeRepository.js";
import type { BudgetRepository } from "../db/budgetRepository.js";
import type { ConversationMessage, DiscordAiAgentRepository } from "../db/repositories.js";
import type { RngRepository } from "../db/rngRepository.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { WalletService } from "../payments/walletService.js";

export type ToolContext = {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  budgetRepo?: BudgetRepository;
  rngRepo?: RngRepository;
  walletService?: WalletService;
  agentRuntime?: AgentRuntimeRepository;
  agentRuntimeSession?: AgentRuntimeSessionRecord | null;
  agentRuntimeExecutionId?: string | null;
  openRouter: OpenRouterClient;
  jobs?: JobRuntime;
  guildId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  /** Immutable Discord actor captured at ingress. Payment tools validate this scope before any wallet action. */
  requesterScope?: Readonly<{
    requestId: string;
    messageId: string;
    guildId: string;
    channelId: string;
    userId: string;
    userDisplayName: string;
  }>;
  visibleChannelIds: string[];
  mentionedUserIds?: string[];
  mentionedChannelIds?: string[];
  threadKey?: string;
  sessionMessages?: ConversationMessage[];
  replyContext?: DiscordReplyContext;
  requestAttachments?: DiscordAttachmentContext[];
  generatedFiles?: AgentFile[];
  generatedTables?: AgentTable[];
  /** Non-model footer lines appended verbatim to the final Discord reply (e.g. RNG fairness proofs). */
  footerLines?: string[];
  requestId?: string;
  /** Exact current user request, available to tools that need request-level validation. */
  requestText?: string;
  /** Discord id of the message that triggered this request; assigned by Discord, not the bot. */
  requestMessageId?: string;
  statusChannelId?: string;
  statusMessageId?: string;
  visibleIndexedChannelIds?: string[];
  deleteDiscordMessageIds?: (messageIds: string[]) => Promise<number>;
  updateStatus?: (content: string) => Promise<void>;
  sendDiscordPoll?: (input: {
    question: string;
    answers: string[];
    durationHours: number;
    allowMultiselect: boolean;
  }) => Promise<{ messageId: string; channelId: string; url: string }>;
  fetchDiscordUserAvatar?: (input: {
    guildId: string;
    userId: string;
  }) => Promise<DiscordUserAvatarResult | null>;
  fetchDiscordGuildMembers?: (input: { guildId: string }) => Promise<DiscordGuildMemberSummary[]>;
  fetchDiscordAttachment?: (input: {
    channelId: string;
    messageId: string;
    attachmentId: string;
  }) => Promise<DiscordAttachmentContext | null>;
  noteProgress?: () => void;
};

export type DiscordGuildMemberSummary = {
  userId: string;
  username: string | null;
  displayName: string | null;
  isBot: boolean;
};

export type DiscordUserAvatarResult = {
  avatarUrl: string;
  globalAvatarUrl: string | null;
  username: string | null;
  globalName: string | null;
  isBot: boolean;
  hasCustomAvatar: boolean;
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

export type AgentTableCell = string | number | boolean | null;

export type AgentTable = {
  name: string;
  columns: string[];
  rows: Array<Record<string, AgentTableCell>>;
  description?: string;
  sourceFileName?: string;
};

export type AgentResponse = {
  content: string;
  status?: "ok" | "error" | "partial";
  errorCode?: string;
  retryable?: boolean;
  limitation?: string;
  files?: AgentFile[];
  tables?: AgentTable[];
  /** Non-model footer lines rendered as Discord subtext under the reply. */
  footerLines?: string[];
  storedContent?: string;
  memoryEvents?: Array<{
    role: "tool";
    content: string;
    metadata?: Record<string, unknown>;
  }>;
};
