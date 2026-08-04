export type PersistedAttachment = {
  id: string;
  url: string;
  proxyUrl?: string | null;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  raw?: unknown;
};

export type PersistedMessage = {
  id: string;
  guildId: string;
  channelId: string;
  threadId?: string | null;
  authorId: string;
  authorUsername?: string | null;
  authorGlobalName?: string | null;
  authorIsBot?: boolean;
  authorRaw?: unknown;
  content: string;
  normalizedContent: string;
  createdAt: Date;
  editedAt?: Date | null;
  messageType?: number | null;
  isPinned?: boolean | null;
  referencedMessageId?: string | null;
  referencedChannelId?: string | null;
  referencedGuildId?: string | null;
  memberDisplayName?: string | null;
  memberNickname?: string | null;
  memberRoles?: string[];
  memberJoinedAt?: Date | null;
  memberRaw?: unknown;
  raw?: unknown;
  attachments?: PersistedAttachment[];
};

export type SearchResult = {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorUsername: string | null;
  content: string;
  normalizedContent: string;
  createdAt: Date;
  score: number;
  link: string;
};

export type DiscordBugMarker = {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  markedAt: Date;
  messageAuthorId: string;
  messageAuthorUsername: string | null;
  messageAuthorIsBot: boolean;
  messageContent: string;
  messageCreatedAt: Date;
  messageLink: string;
  promptMessageId: string | null;
  promptAuthorId: string | null;
  promptAuthorUsername: string | null;
  promptContent: string | null;
  promptCreatedAt: Date | null;
  promptLink: string | null;
};

export type DiscordBugReportStatus = "pending" | "queued" | "running" | "completed" | "failed";
export type DiscordBugReportDisposition =
  | "confirmed_fixed"
  | "confirmed_unfixed"
  | "expected_behavior"
  | "not_reproducible"
  | "already_fixed"
  | "insufficient_evidence";

export type DiscordBugReport = {
  reportId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  sourceSessionId: string | null;
  sourceExecutionId: string | null;
  sourceRevision: string;
  reportedByUserId: string;
  taskId: string | null;
  statusMessageId: string | null;
  status: DiscordBugReportStatus;
  disposition: DiscordBugReportDisposition | null;
  summary: string | null;
  prUrl: string | null;
  mergeCommitSha: string | null;
  deployedRevision: string | null;
  retryStatus: "running" | "succeeded" | "failed" | null;
  retryExecutionId: string | null;
  announcementMessageId: string | null;
  retriedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type DiscordBugInboxStatus = {
  markedAt: Date;
  validationStatus: DiscordBugReportStatus | "marked";
  disposition: DiscordBugReportDisposition | null;
  prUrl: string | null;
  deployedRevision: string | null;
  retryStatus: DiscordBugReport["retryStatus"];
  updatedAt: Date;
};

export type DiscordUserLookupResult = {
  id: string;
  username: string | null;
  globalName: string | null;
  aliases: string[];
  isBot: boolean;
  messageCount: number;
  lastMessageAt: Date | null;
  score: number;
};

export type DiscordUserAlias = {
  guildId: string;
  userId: string;
  username: string | null;
  globalName: string | null;
  alias: string;
  normalizedAlias: string;
  createdAt: Date;
  updatedAt: Date;
};

export type DiscordUserReferenceTerms = {
  userId: string;
  username: string | null;
  globalName: string | null;
  aliases: string[];
  terms: string[];
};

export type DiscordChannelLookupResult = {
  id: string;
  guildId: string;
  parentId: string | null;
  name: string | null;
  type: number;
  isThread: boolean;
  messageCount: number;
  lastMessageAt: Date | null;
  score: number;
};

export type DiscordAttachmentSearchResult = {
  attachmentId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorUsername: string | null;
  normalizedContent: string;
  createdAt: Date;
  url: string;
  proxyUrl: string | null;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  link: string;
};

export type DiscordStats = {
  totalMessages: number;
  totalAttachments: number;
  totalReactions: number;
  userCount: number;
  channelCount: number;
  activeDays: number;
  metric: DiscordStatsMetric;
  groupBy: DiscordStatsGroupBy;
  rows: DiscordStatsRow[];
  topUsers: Array<{ authorId: string; authorUsername: string | null; messageCount: number }>;
  topChannels: Array<{ channelId: string; channelName: string | null; messageCount: number }>;
};

export type DiscordStatsMetric =
  | "messages"
  | "attachments"
  | "reactions"
  | "uniqueActiveDays"
  | "messagesPerActiveDay"
  | "messagesPerChannelDay";
export type DiscordStatsGroupBy =
  | "overall"
  | "user"
  | "channel"
  | "thread"
  | "message"
  | "day"
  | "week"
  | "month"
  | "year"
  | "hourOfDay"
  | "dayOfWeek";
export type DiscordStatsSort = "countDesc" | "countAsc" | "dateAsc" | "dateDesc" | "labelAsc";

export type DiscordStatsRow = {
  key: string;
  label: string;
  value: number;
  authorId: string | null;
  authorUsername: string | null;
  channelId: string | null;
  channelName: string | null;
  messageId: string | null;
  messageLink: string | null;
  periodStart: Date | null;
  messageCount: number;
  activeDays: number;
  channelCreatedAt: Date | null;
  channelAgeDays: number | null;
};

export type DiscordChannelTopicCandidate = {
  channelId: string;
  channelName: string | null;
  messageId: string;
  authorUsername: string | null;
  normalizedContent: string;
  createdAt: Date;
  embedding: number[] | null;
  channelMessageCount: number;
};

export type ConversationRole = "user" | "assistant" | "tool";

export type ConversationMessage = {
  id: number;
  threadKey: string;
  discordMessageId: string | null;
  role: ConversationRole;
  authorId: string | null;
  authorDisplayName: string | null;
  content: string;
  parts: unknown[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AgentMemoryAnchorMessage = {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
  content: string;
  normalizedContent: string;
  createdAt: Date;
  link: string;
};

export type AgentMemoryTurnStats = {
  anchor: AgentMemoryAnchorMessage | null;
  completedTurnCount: number;
  recentAssistantTurns: ConversationMessage[];
};

export type MessageForEmbedding = {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  normalizedContent: string;
  deletedAt: Date | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingInputVersion: number | null;
  embeddingInputSha256: string | null;
};

export type DeletedConversationTurn = {
  deletedRows: number;
  assistantDiscordMessageId: string | null;
};

export type DeletedConversationTurns = {
  deletedRows: number;
  deletedTurns: number;
  assistantDiscordMessageIds: string[];
};

export type InteractionBlock = {
  guildId: string;
  userId: string;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EventLevel = "debug" | "info" | "warn" | "error";

export type ToolAuditLog = {
  id: number;
  traceId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  toolName: string;
  argumentsSummary: string | null;
  resultSummary: string | null;
  error: string | null;
  model: string | null;
  estimatedCostUsd: number | null;
  createdAt: Date;
};

export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export type AgentTaskRecord = {
  taskId: string;
  pgBossJobId: string | null;
  traceId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  threadKey: string | null;
  discordResponseChannelId: string | null;
  discordResponseMessageId: string | null;
  retriedFromTaskId: string | null;
  taskType: string;
  title: string;
  request: string;
  requestedBy: string;
  status: AgentTaskStatus;
  backend: string | null;
  currentStep: string | null;
  statusMessage: string | null;
  branchName: string | null;
  prUrl: string | null;
  draft: boolean | null;
  verifyPassed: boolean | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  notifiedAt: Date | null;
  notificationError: string | null;
  progressUpdatedAt: Date | null;
  lastRenderedSignature: string | null;
  lastRenderedAt: Date | null;
  terminalRenderedAt: Date | null;
  updatedAt: Date;
};

export type TaskEvent = {
  id: number;
  taskId: string;
  traceId: string | null;
  eventName: string;
  level: EventLevel;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AgentRuntimeEvent = {
  id: number;
  sessionId: string;
  executionId: string | null;
  traceId: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  kind: string;
  level: EventLevel;
  eventName: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  durationMs: number | null;
  createdAt: Date;
};

export type AgentRunFeedback = {
  runId: string;
  rating: "good" | "bad";
  note: string | null;
  expectedBehavior: string | null;
  failureMode: "wrong_answer" | "unnecessary_refusal" | "wrong_tool" | "missing_evidence" | "permission" | "delivery" | "latency" | "other" | null;
  expectedTools: string[];
  forbiddenTools: string[];
  mustContain: string[];
  mustNotContain: string[];
  captureEval: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentRuntimeMessage = {
  messageId: string;
  sessionId: string;
  clientMessageId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  parts: unknown[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AgentRuntimeStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export type AgentRuntimeChatExecution = {
  executionId: string;
  sessionId: string;
  traceId: string | null;
  sessionTraceId: string | null;
  status: AgentRuntimeStatus;
  title: string;
  request: string;
  requestedBy: string | null;
  error: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  metadata: Record<string, unknown>;
  sessionMetadata: Record<string, unknown>;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

export type AgentRuntimeArtifactRecord = {
  artifactId: string;
  sessionId: string;
  executionId: string | null;
  kind: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  preview: string;
  redacted: boolean;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AgentRuntimeArtifactContent = AgentRuntimeArtifactRecord & { content: string };

export type SandboxRunRecord = {
  sandboxRunId: string;
  taskId: string;
  taskStatus: AgentTaskStatus | null;
  backend: string;
  namespace: string | null;
  backendJobName: string | null;
  image: string | null;
  status: string;
  metadata: Record<string, unknown>;
  startedAt: Date | null;
  completedAt: Date | null;
  cleanedUpAt: Date | null;
  updatedAt: Date;
};

export type SandboxCommandEvent = {
  id: number;
  taskId: string;
  sandboxRunId: string | null;
  step: string;
  command: string | null;
  exitCode: number | null;
  outputTail: string;
  errorTail: string;
  durationMs: number | null;
  createdAt: Date;
};

export type ServerOverlay = {
  guildId: string;
  enabled: boolean;
  systemPrompt: string;
  toolPolicy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};
