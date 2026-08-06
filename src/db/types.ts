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

export type ImprovementCaseStatus = "open" | "needs_evidence" | "actionable" | "in_progress" | "verifying" | "resolved" | "dismissed";
export type ImprovementClassification = "unknown" | "defect" | "product_gap" | "data_quality" | "developer_friction" | "external_incident" | "expected_behavior";
export type ImprovementSeverity = "low" | "medium" | "high" | "critical";
export type ImprovementPrivacy = "private" | "publication_safe";
export type ImprovementSignalSource = "member_report" | "agent_report" | "operator_report" | "developer_report" | "runtime_detection" | "deployment_detection" | "ci_detection" | "eval_detection";
export type ImprovementWorkSource = "agent_task" | "github_pull_request";
export type ImprovementWorkStatus = "in_progress" | "succeeded" | "failed" | "cancelled";
export type ImprovementAutomationState = "pending" | "progressing" | "waiting" | "blocked" | "complete";

export type ImprovementCaseHealth = {
  caseId: string;
  state: ImprovementAutomationState;
  blocker: string | null;
  nextAction: string;
  retryTrigger: string | null;
  retryAt: Date | null;
  details: Record<string, unknown>;
  progressKey: string;
  lastProgressAt: Date;
  checkedAt: Date;
};

export type ImprovementCase = {
  caseId: string;
  guildId: string | null;
  scope: "guild" | "repository" | "deployment" | "global";
  privacy: ImprovementPrivacy;
  title: string;
  status: ImprovementCaseStatus;
  classification: ImprovementClassification;
  severity: ImprovementSeverity;
  owningDomain: string | null;
  fingerprint: string | null;
  mergedIntoCaseId: string | null;
  resolution: string | null;
  version: number;
  metadata: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ImprovementSignal = {
  signalId: string;
  caseId: string;
  source: ImprovementSignalSource;
  sourceKey: string;
  reporterKind: "member" | "agent" | "operator" | "developer" | "automation";
  reporterId: string | null;
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  executionId: string | null;
  taskId: string | null;
  appRevision: string | null;
  privacy: ImprovementPrivacy;
  summary: string;
  details: string | null;
  severityHint: ImprovementSeverity | null;
  classificationHint: ImprovementClassification | null;
  owningDomainHint: string | null;
  fingerprint: string | null;
  active: boolean;
  metadata: Record<string, unknown>;
  observedAt: Date;
  withdrawnAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ImprovementReporterConversation = {
  conversationId: string;
  caseId: string;
  guildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  reporterId: string;
  signalActive: boolean;
  caseStatus: ImprovementCaseStatus;
  caseResolution: string | null;
  deliveryKind: "thread" | "dm" | null;
  deliveryChannelId: string | null;
  deliveryMessageId: string | null;
  clarificationTaskId: string | null;
  clarificationQuestion: string | null;
  clarificationAnswer: string | null;
  answerSignalId: string | null;
  lastRenderedSignature: string | null;
  lastRenderedAt: Date | null;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  nextDeliveryAt: Date | null;
  deliveryAbandonedAt: Date | null;
  clarificationRequestedAt: Date | null;
  answeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ImprovementWorkAttempt = {
  workId: string;
  caseId: string;
  source: ImprovementWorkSource;
  sourceKey: string;
  status: ImprovementWorkStatus;
  taskId: string | null;
  repository: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  headRevision: string | null;
  mergeRevision: string | null;
  metadata: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ImprovementPullRequestSnapshot = {
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  state: "open" | "closed" | "merged";
  headRevision: string;
  mergeRevision?: string | null;
  nodeId?: string | null;
  draft?: boolean;
  mergeable?: "mergeable" | "conflicting" | "unknown";
  mergeStateStatus?: string | null;
  reviewDecision?: "approved" | "changes_requested" | "review_required" | null;
  unresolvedReviewThreads?: number;
  checkRollupState?: "success" | "failure" | "error" | "pending" | null;
  autoMergeEnabled?: boolean;
};

export type ImprovementContractCheck =
  | { kind: "tool"; name: string; expectation: "required" | "forbidden" }
  | { kind: "answer_text"; value: string; expectation: "required" | "forbidden" }
  | { kind: "runtime_event"; name: string; expectation: "required" | "forbidden" }
  | { kind: "delivery_state"; state: string }
  | { kind: "test"; reference: string }
  | { kind: "eval"; reference: string }
  | { kind: "database_invariant"; reference: string }
  | { kind: "deployment_canary"; reference: string }
  | { kind: "schedule_health"; reference: string }
  | { kind: "proof_producer_health"; reference: string }
  | { kind: "manual"; description: string };

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
  totalValue: number;
  totalAttachments: number;
  totalReactions: number;
  userCount: number;
  channelCount: number;
  activeDays: number;
  metric: DiscordStatsMetric;
  groupBy: DiscordStatsGroupBy;
  rows: DiscordStatsRow[];
  topUsers: Array<{ authorId: string; authorUsername: string | null; messageCount: number; value: number }>;
  topChannels: Array<{ channelId: string; channelName: string | null; messageCount: number; value: number }>;
};

export type DiscordStatsMetric =
  | "messages"
  | "characters"
  | "words"
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
  improvementCaseId: string | null;
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
