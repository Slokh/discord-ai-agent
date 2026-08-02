import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository, AgentRuntimeSessionRecord } from "../db/agentRuntimeRepository.js";
import type { BudgetRepository } from "../db/budgetRepository.js";
import type { ConversationMessage, DiscordAiAgentRepository } from "../db/repositories.js";
import type { RngRepository } from "../db/rngRepository.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { WalletService } from "../payments/walletService.js";
import type { DiscordPresentation } from "../discord/components/types.js";

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
  mentionedUsers?: DiscordMentionedUserIdentity[];
  mentionedChannelIds?: string[];
  threadKey?: string;
  sessionMessages?: ConversationMessage[];
  replyContext?: DiscordReplyContext;
  requestAttachments?: DiscordAttachmentContext[];
  /** Turn-scoped output collector shared by model tools and final synthesis. */
  turnOutput?: AgentTurnOutput;
  requestId?: string;
  /** Exact current user request, available to tools that need request-level validation. */
  requestText?: string;
  /** Discord id of the message that triggered this request; assigned by Discord, not the bot. */
  requestMessageId?: string;
  /** Durable per-guild primary chat-model override loaded before model selection. */
  chatModelOverride?: string | null;
  chatModelOverrideLoaded?: boolean;
  /** True only for a current Discord message that may authorize model-selected mutations. */
  mutationAuthorizedByCurrentInput: boolean;
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
  addDiscordReaction?: (input: {
    channelId: string;
    messageId: string;
    emoji: string;
  }) => Promise<{ messageId: string; channelId: string; url: string; emoji: string }>;
  createDiscordEmoji?: (input: {
    name: string;
    image: Buffer;
    auditLogReason: string;
  }) => Promise<{
    id: string;
    name: string;
    animated: boolean;
    mention: string;
    url: string;
  }>;
  fetchDiscordUserAvatar?: (input: {
    guildId: string;
    userId: string;
  }) => Promise<DiscordUserAvatarResult | null>;
  fetchDiscordGuildMembers?: (input: { guildId: string }) => Promise<DiscordGuildMemberSummary[]>;
  discordGuildEmojis?: DiscordGuildEmojiSummary[];
  /** Bounded dynamic culture guidance reused by tool-backed final synthesis. */
  discordEmojiCulturePrompt?: string;
  fetchDiscordAttachment?: (input: {
    channelId: string;
    messageId: string;
    attachmentId: string;
  }) => Promise<DiscordAttachmentContext | null>;
  /** Aborted when the enclosing Discord request times out; late work must not execute tools. */
  abortSignal?: AbortSignal;
  noteProgress?: () => void;
};

export type DiscordMentionedUserIdentity = {
  userId: string;
  mention: string;
  username: string | null;
  displayName: string | null;
};

export type DiscordGuildMemberSummary = {
  userId: string;
  username: string | null;
  displayName: string | null;
  isBot: boolean;
};

export type DiscordGuildEmojiSummary = {
  id: string;
  name: string;
  animated: boolean;
  mention: string;
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
  /** Bounded exact emoji/count summaries visible on this retained message. */
  reactionSummaries?: string[];
  createdAt: string | null;
  url: string | null;
  /** True when Discord exposed this parent through a forwarded message snapshot. */
  forwarded?: boolean;
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

export type AgentTurnOutput = {
  files: AgentFile[];
  tables: AgentTable[];
  footerLines: string[];
  presentation?: DiscordPresentation;
  addFooterLines: (...lines: string[]) => void;
  setPresentation: (presentation: DiscordPresentation) => void;
  snapshot: () => Readonly<{
    files: AgentFile[];
    tables: AgentTable[];
    footerLines: string[];
    presentation?: DiscordPresentation;
  }>;
};

export type AgentResponse = {
  content: string;
  status?: "ok" | "error" | "partial";
  errorCode?: string;
  retryable?: boolean;
  limitation?: string;
  /** Machine-readable tool state for orchestration; never rendered directly to Discord. */
  outcome?: {
    kind: string;
    state: "succeeded" | "failed" | "awaiting_action" | "settled";
    nextTool?: string;
    /** A wallet-backed wager is active after this result and requires a typed lifecycle transition. */
    wagerActive?: boolean;
    /** The tool result is already a complete, grounded answer to the request. */
    terminal?: boolean;
  };
  files?: AgentFile[];
  tables?: AgentTable[];
  /** Validated Discord Components V2 presentation rendered by the Discord delivery boundary. */
  discordPresentation?: DiscordPresentation;
  /** Non-model footer lines rendered as Discord subtext under the reply. */
  footerLines?: string[];
  storedContent?: string;
  memoryEvents?: Array<{
    role: "tool";
    content: string;
    metadata?: Record<string, unknown>;
  }>;
};
