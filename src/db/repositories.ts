import type { DbPool } from "./pool.js";
import * as skillsRepository from "./skillsRepository.js";
import * as embeddingRepository from "./embeddingRepository.js";
import * as conversationMemoryRepository from "./conversationMemoryRepository.js";
import * as auditRepository from "./auditRepository.js";
import * as processRunRepository from "./processRunRepository.js";
import * as agentTaskRepository from "./agentTaskRepository.js";
import * as discordArchiveRepository from "./discordArchiveRepository.js";
import * as discordBugMarkerRepository from "./discordBugMarkerRepository.js";
import * as discordEmojiUsageRepository from "./discordEmojiUsageRepository.js";
import * as deploymentAnnouncementRepository from "./deploymentAnnouncementRepository.js";
import * as discordComponentActionRepository from "./discordComponentActionRepository.js";
import * as retrievalRepository from "./retrievalRepository.js";
import type { PersistedMessage, SearchResult, DiscordBugMarker, DiscordUserLookupResult, DiscordUserReferenceTerms, DiscordChannelLookupResult, DiscordAttachmentSearchResult, DiscordStats, DiscordStatsMetric, DiscordStatsGroupBy, DiscordStatsSort, DiscordChannelTopicCandidate, ConversationRole, ConversationMessage, AgentMemoryTurnStats, MessageForEmbedding, DeletedConversationTurn, DeletedConversationTurns, InteractionBlock, DatabaseSkill, TraceEventLevel, TraceEvent, ToolAuditLog, ProcessRunKind, ProcessRunStatus, ProcessRunArtifactKind, ProcessRunRecord, ProcessRunSpanRecord, ProcessRunEventRecord, ProcessRunArtifactRecord, ProcessRunArtifactContent, AgentTaskStatus, AgentTaskRecord, TaskEvent, AgentRuntimeEvent, AgentRuntimeMessage, AgentRuntimeChatExecution, AgentRuntimeArtifactRecord, AgentRuntimeArtifactContent, SandboxRunRecord, SandboxCommandEvent, ServerOverlay, AgentRunFeedback } from "./types.js";
export type { PersistedAttachment, PersistedMessage, SearchResult, DiscordBugMarker, DiscordUserLookupResult, DiscordUserAlias, DiscordUserReferenceTerms, DiscordChannelLookupResult, DiscordAttachmentSearchResult, DiscordStats, DiscordStatsMetric, DiscordStatsGroupBy, DiscordStatsSort, DiscordStatsRow, DiscordChannelTopicCandidate, ConversationRole, ConversationMessage, AgentMemoryAnchorMessage, AgentMemoryTurnStats, MessageForEmbedding, DeletedConversationTurn, DeletedConversationTurns, InteractionBlock, DatabaseSkill, TraceEventLevel, TraceEvent, ToolAuditLog, ProcessRunKind, ProcessRunStatus, ProcessRunArtifactKind, ProcessRunRecord, ProcessRunSpanRecord, ProcessRunEventRecord, ProcessRunArtifactRecord, ProcessRunArtifactContent, AgentTaskStatus, AgentTaskRecord, TaskEvent, AgentRuntimeEvent, AgentRuntimeMessage, AgentRuntimeChatExecution, AgentRuntimeArtifactRecord, AgentRuntimeArtifactContent, SandboxRunRecord, SandboxCommandEvent, ServerOverlay, AgentRunFeedback } from "./types.js";
export type { DiscordEmojiCultureProfile, DiscordEmojiUsageExample } from "./discordEmojiUsageRepository.js";

// Retrieval SQL lives in retrievalRepository.ts; keep this guardrail snippet here
// for repository-permissions.test.ts import-compatibility coverage:
// c.parent_id = ANY($2::text[]) AND c.type IN (10, 11)

export class DiscordAiAgentRepository {
  constructor(private readonly pool: DbPool) {}
  createDiscordComponentActionGeneration(input: Parameters<typeof discordComponentActionRepository.createDiscordComponentActionGeneration>[1]) { return discordComponentActionRepository.createDiscordComponentActionGeneration(this.pool, input); }
  activateDiscordComponentActionGeneration(input: Parameters<typeof discordComponentActionRepository.activateDiscordComponentActionGeneration>[1]) { return discordComponentActionRepository.activateDiscordComponentActionGeneration(this.pool, input); }
  cancelDiscordComponentActionGeneration(input: Parameters<typeof discordComponentActionRepository.cancelDiscordComponentActionGeneration>[1]) { return discordComponentActionRepository.cancelDiscordComponentActionGeneration(this.pool, input); }
  cancelDiscordComponentActionsForResponseMessage(input: Parameters<typeof discordComponentActionRepository.cancelDiscordComponentActionsForResponseMessage>[1]) { return discordComponentActionRepository.cancelDiscordComponentActionsForResponseMessage(this.pool, input); }
  expireDiscordComponentActions(input?: Parameters<typeof discordComponentActionRepository.expireDiscordComponentActions>[1]) { return discordComponentActionRepository.expireDiscordComponentActions(this.pool, input); }
  resolveDiscordComponentAction(input: Parameters<typeof discordComponentActionRepository.resolveDiscordComponentAction>[1]) { return discordComponentActionRepository.resolveDiscordComponentAction(this.pool, input); }
  claimDeploymentAnnouncement(input: deploymentAnnouncementRepository.DeploymentAnnouncementClaim) { return deploymentAnnouncementRepository.claimDeploymentAnnouncement(this.pool, input); }
  recordDeploymentBaseline(input: Omit<deploymentAnnouncementRepository.DeploymentAnnouncementClaim, "previousRevision">) { return deploymentAnnouncementRepository.recordDeploymentBaseline(this.pool, input); }
  latestDeploymentRevision(guildId: string) { return deploymentAnnouncementRepository.latestDeploymentRevision(this.pool, guildId); }
  markDeploymentAnnouncementPosted(input: { guildId: string; revision: string; content: string; comparisonUrl: string; discordMessageId: string }) { return deploymentAnnouncementRepository.markDeploymentAnnouncementPosted(this.pool, input); }
  markDeploymentAnnouncementFailed(input: { guildId: string; revision: string; error: string }) { return deploymentAnnouncementRepository.markDeploymentAnnouncementFailed(this.pool, input); }
  recordSkillChange(input: {
    skillName: string;
    filePath: string;
    requesterId?: string | null;
    request?: string | null;
    branchName?: string | null;
    prUrl?: string | null;
    content?: string | null;
    source?: string;
    merged?: boolean;
    policyReasons?: string[];
  }) { return skillsRepository.recordSkillChange(this.pool, input); }
  listEnabledDatabaseSkills(): Promise<Array<{ name: string; content: string; version: number }>> { return skillsRepository.listEnabledDatabaseSkills(this.pool); }
  listDatabaseSkills(input: { includeDisabled?: boolean } = {}): Promise<DatabaseSkill[]> { return skillsRepository.listDatabaseSkills(this.pool, input); }
  upsertDatabaseSkill(input: { name: string; content: string; requesterId?: string | null; request?: string | null }): Promise<DatabaseSkill> { return skillsRepository.upsertDatabaseSkill(this.pool, input); }
  setDatabaseSkillEnabled(input: { name: string; enabled: boolean; requesterId?: string | null }): Promise<DatabaseSkill | null> { return skillsRepository.setDatabaseSkillEnabled(this.pool, input); }
  deleteDatabaseSkill(name: string): Promise<boolean> { return skillsRepository.deleteDatabaseSkill(this.pool, name); }
  getServerOverlay(guildId: string): Promise<ServerOverlay | undefined> { return skillsRepository.getServerOverlay(this.pool, guildId); }
  upsertServerOverlay(input: {
    guildId: string;
    enabled?: boolean;
    systemPrompt?: string;
    toolPolicy?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    updatedBy?: string | null;
  }): Promise<ServerOverlay> { return skillsRepository.upsertServerOverlay(this.pool, input); }
  health() { return skillsRepository.health(this.pool); }
  async getRunFeedback(runId: string): Promise<AgentRunFeedback | undefined> {
    const result = await this.pool.query("SELECT * FROM agent_run_feedback WHERE run_id = $1", [runId]);
    return result.rows[0] ? rowToRunFeedback(result.rows[0]) : undefined;
  }
  async upsertRunFeedback(input: { runId: string; rating: "good" | "bad"; note?: string | null; expectedBehavior?: string | null; captureEval?: boolean }): Promise<AgentRunFeedback> {
    const result = await this.pool.query(
      `INSERT INTO agent_run_feedback(run_id, rating, note, expected_behavior, capture_eval)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(run_id) DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note,
         expected_behavior = EXCLUDED.expected_behavior, capture_eval = EXCLUDED.capture_eval, updated_at = now()
       RETURNING *`,
      [input.runId, input.rating, input.note ?? null, input.expectedBehavior ?? null, Boolean(input.captureEval)]
    );
    return rowToRunFeedback(result.rows[0]);
  }
  storeMessageEmbedding(input: {
    messageId: string;
    embedding: number[];
    model: string;
    dimensions?: number;
    inputVersion?: number;
    inputText?: string;
    inputSha256?: string | null;
  }) { return embeddingRepository.storeMessageEmbedding(this.pool, input); }
  storeMessageEmbeddings(input: {
    model: string;
    dimensions?: number;
    inputVersion?: number;
    items: Array<{ messageId: string; embedding: number[]; inputText?: string; inputSha256?: string | null }>;
  }) { return embeddingRepository.storeMessageEmbeddings(this.pool, input); }
  getMessageForEmbedding(messageId: string): Promise<MessageForEmbedding | undefined> { return embeddingRepository.getMessageForEmbedding(this.pool, messageId); }
  getMessagesForEmbedding(messageIds: string[]): Promise<MessageForEmbedding[]> { return embeddingRepository.getMessagesForEmbedding(this.pool, messageIds); }
  messageIdsNeedingEmbeddings(input: {
    guildId: string;
    model: string;
    dimensions?: number;
    inputVersion?: number;
    limit: number;
    botUserId?: string;
  }): Promise<string[]> { return embeddingRepository.messageIdsNeedingEmbeddings(this.pool, input); }
  embeddingBacklog(input: { guildId: string; model: string; dimensions?: number; inputVersion?: number; botUserId?: string }) { return embeddingRepository.embeddingBacklog(this.pool, input); }
  ensureConversationSession(input: {
    threadKey: string;
    guildId: string;
    channelId: string;
    metadata?: Record<string, unknown>;
  }) { return conversationMemoryRepository.ensureConversationSession(this.pool, input); }
  appendConversationMessage(input: {
    threadKey: string;
    role: ConversationRole;
    content: string;
    discordMessageId?: string | null;
    authorId?: string | null;
    authorDisplayName?: string | null;
    parts?: unknown[];
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  }) { return conversationMemoryRepository.appendConversationMessage(this.pool, input); }
  appendConversationTurn(input: {
    threadKey: string;
    turnId: string;
    user: {
      content: string;
      discordMessageId: string;
      authorId?: string | null;
      authorDisplayName?: string | null;
      parts?: unknown[];
      metadata?: Record<string, unknown>;
      createdAt?: Date;
    };
    assistant: {
      content: string;
      discordMessageId: string;
      authorId?: string | null;
      authorDisplayName?: string | null;
      parts?: unknown[];
      metadata?: Record<string, unknown>;
      createdAt?: Date;
    };
  }) { return conversationMemoryRepository.appendConversationTurn(this.pool, input); }
  recentConversationMessages(input: { threadKey: string; limit: number; includeToolResults?: boolean }): Promise<ConversationMessage[]> { return conversationMemoryRepository.recentConversationMessages(this.pool, input); }
  agentMemoryTurnStats(input: {
    guildId: string;
    channelId: string;
    threadKey: string;
    anchorText?: string | null;
    anchorMessageId?: string | null;
    anchorAuthorId?: string | null;
    excludeMessageId?: string | null;
    limit?: number;
  }): Promise<AgentMemoryTurnStats> { return conversationMemoryRepository.agentMemoryTurnStats(this.pool, input); }
  deleteConversationMessagesByDiscordMessageIds(input: { threadKey: string; discordMessageIds: string[] }): Promise<number> { return conversationMemoryRepository.deleteConversationMessagesByDiscordMessageIds(this.pool, input); }
  deleteMostRecentConversationTurn(threadKey: string): Promise<DeletedConversationTurn> { return conversationMemoryRepository.deleteMostRecentConversationTurn(this.pool, threadKey); }
  deleteMostRecentConversationTurns(input: { threadKey: string; count: number }): Promise<DeletedConversationTurns> { return conversationMemoryRepository.deleteMostRecentConversationTurns(this.pool, input); }
  auditTool(input: {
    traceId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    toolName: string;
    argumentsSummary?: string | null;
    resultSummary?: string | null;
    error?: string | null;
    model?: string | null;
    estimatedCostUsd?: number | null;
  }) { return auditRepository.auditTool(this.pool, input); }
  recordTraceEvent(input: {
    traceId?: string | null;
    requestId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    eventName: string;
    level?: TraceEventLevel;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }) { return auditRepository.recordTraceEvent(this.pool, input); }
  getTraceEvents(input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<TraceEvent[]> { return auditRepository.getTraceEvents(this.pool, input); }
  getTraceEventsForTrace(input: { traceId: string; limit?: number }): Promise<TraceEvent[]> { return auditRepository.getTraceEventsForTrace(this.pool, input); }
  getToolAuditLogs(input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<ToolAuditLog[]> { return auditRepository.getToolAuditLogs(this.pool, input); }
  getToolAuditLogsForTrace(input: { traceId: string; limit?: number }): Promise<ToolAuditLog[]> { return auditRepository.getToolAuditLogsForTrace(this.pool, input); }
  upsertProcessRun(input: {
    runId: string;
    traceId?: string | null;
    kind: ProcessRunKind;
    status?: ProcessRunStatus;
    title: string;
    summary?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    requester?: string | null;
    source?: string | null;
    metadata?: Record<string, unknown>;
    links?: Record<string, unknown>;
    startedAt?: Date | null;
    completedAt?: Date | null;
  }): Promise<ProcessRunRecord> { return processRunRepository.upsertProcessRun(this.pool, input); }
  updateProcessRun(input: {
    runId: string;
    status?: ProcessRunStatus;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    links?: Record<string, unknown>;
    completedAt?: Date | null;
  }): Promise<ProcessRunRecord | undefined> { return processRunRepository.updateProcessRun(this.pool, input); }
  markStaleProcessRuns(input: {
    kind?: ProcessRunKind;
    staleBefore: Date;
    limit?: number;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProcessRunRecord[]> { return processRunRepository.markStaleProcessRuns(this.pool, input); }
  recordProcessRunSpan(input: {
    runId: string;
    spanId: string;
    parentSpanId?: string | null;
    name: string;
    status?: ProcessRunStatus;
    startedAt?: Date | null;
    completedAt?: Date | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProcessRunSpanRecord | undefined> { return processRunRepository.recordProcessRunSpan(this.pool, input); }
  recordProcessRunEvent(input: {
    runId: string;
    traceId?: string | null;
    level?: TraceEventLevel;
    eventName: string;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }): Promise<ProcessRunEventRecord | undefined> { return processRunRepository.recordProcessRunEvent(this.pool, input); }
  storeProcessRunArtifact(input: {
    runId: string;
    kind: ProcessRunArtifactKind;
    name: string;
    content: string;
    contentType?: string | null;
    metadata?: Record<string, unknown>;
    expiresAt?: Date | null;
  }): Promise<ProcessRunArtifactRecord | undefined> { return processRunRepository.storeProcessRunArtifact(this.pool, input); }
  cleanupExpiredProcessRunArtifacts(limit = 500): Promise<number> { return processRunRepository.cleanupExpiredProcessRunArtifacts(this.pool, limit); }
  listProcessRuns(input: { limit?: number; kind?: ProcessRunKind | null; status?: ProcessRunStatus | null; includeEmbeddings?: boolean } = {}): Promise<ProcessRunRecord[]> { return processRunRepository.listProcessRuns(this.pool, input); }
  listProcessRunsForTrace(input: { traceId: string; limit?: number }): Promise<ProcessRunRecord[]> { return processRunRepository.listProcessRunsForTrace(this.pool, input); }
  listProcessRunsByParentAgentExecutionId(input: { parentAgentExecutionId: string; limit?: number }): Promise<ProcessRunRecord[]> { return processRunRepository.listProcessRunsByParentAgentExecutionId(this.pool, input); }
  findProcessRunByAgentExecutionId(agentExecutionId: string): Promise<ProcessRunRecord | undefined> { return processRunRepository.findProcessRunByAgentExecutionId(this.pool, agentExecutionId); }
  findProcessRunByDiscordMessageId(messageId: string): Promise<ProcessRunRecord | undefined> { return processRunRepository.findProcessRunByDiscordMessageId(this.pool, messageId); }
  getProcessRun(runId: string): Promise<ProcessRunRecord | undefined> { return processRunRepository.getProcessRun(this.pool, runId); }
  getProcessRunSpans(runId: string): Promise<ProcessRunSpanRecord[]> { return processRunRepository.getProcessRunSpans(this.pool, runId); }
  getProcessRunEvents(input: { runId: string; afterId?: number | null; limit?: number }): Promise<ProcessRunEventRecord[]> { return processRunRepository.getProcessRunEvents(this.pool, input); }
  getProcessRunArtifacts(runId: string): Promise<ProcessRunArtifactRecord[]> { return processRunRepository.getProcessRunArtifacts(this.pool, runId); }
  getProcessRunArtifact(input: { runId: string; artifactId: string }): Promise<ProcessRunArtifactContent | undefined> { return processRunRepository.getProcessRunArtifact(this.pool, input); }
  upsertAgentTaskQueued(input: {
    taskId: string;
    pgBossJobId?: string | null;
    traceId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    threadKey?: string | null;
    discordResponseChannelId?: string | null;
    discordResponseMessageId?: string | null;
    retriedFromTaskId?: string | null;
    taskType: string;
    title: string;
    request: string;
    requestedBy: string;
    backend?: string | null;
    parentAgentSessionId?: string | null;
    parentAgentExecutionId?: string | null;
    parentAgentThreadKey?: string | null;
  }) { return agentTaskRepository.upsertAgentTaskQueued(this.pool, input); }
  attachAgentTasksToDiscordResponse(input: { traceId: string; channelId: string; messageId: string }): Promise<number> { return agentTaskRepository.attachAgentTasksToDiscordResponse(this.pool, input); }
  markAgentTaskRunning(input: {
    taskId: string;
    backend?: string | null;
    step?: string | null;
    statusMessage?: string | null;
    pgBossJobId?: string | null;
    workerStartedAt?: Date | null;
    metadata?: Record<string, unknown>;
  }) { return agentTaskRepository.markAgentTaskRunning(this.pool, input); }
  markAgentTaskProgress(input: {
    taskId: string;
    step: string;
    statusMessage: string;
    backend?: string | null;
    metadata?: Record<string, unknown>;
  }) { return agentTaskRepository.markAgentTaskProgress(this.pool, input); }
  recordAgentTaskSandboxLease(input: {
    taskId: string;
    backend?: string | null;
    sandboxId: string;
    leaseOwner?: string | null;
    metadata?: Record<string, unknown>;
  }) { return agentTaskRepository.recordAgentTaskSandboxLease(this.pool, input); }
  recordSandboxRun(input: {
    taskId: string;
    sandboxRunId: string;
    backend: string;
    namespace?: string | null;
    backendJobName?: string | null;
    image?: string | null;
    sandboxId?: string | null;
    leaseOwner?: string | null;
    metadata?: Record<string, unknown>;
  }) { return agentTaskRepository.recordSandboxRun(this.pool, input); }
  markAgentTaskSucceeded(input: {
    taskId: string;
    branchName: string;
    prUrl: string;
    draft: boolean | null;
    verifyPassed: boolean | null;
    metadata?: Record<string, unknown>;
  }) { return agentTaskRepository.markAgentTaskSucceeded(this.pool, input); }
  markAgentTaskFailed(input: {
    taskId: string;
    status?: "failed" | "no_changes" | "cancelled";
    error: string;
    metadata?: Record<string, unknown>;
  }) { return agentTaskRepository.markAgentTaskFailed(this.pool, input); }
  getAgentTask(taskId: string): Promise<AgentTaskRecord | undefined> { return agentTaskRepository.getAgentTask(this.pool, taskId); }
  listRecentAgentTasks(limit = 50): Promise<AgentTaskRecord[]> { return agentTaskRepository.listRecentAgentTasks(this.pool, limit); }
  listAgentTasksForTrace(input: { traceId: string; limit?: number }): Promise<AgentTaskRecord[]> { return agentTaskRepository.listAgentTasksForTrace(this.pool, input); }
  listAgentTasks(input: {
    guildId: string;
    visibleChannelIds?: string[];
    channelId?: string | null;
    statuses?: AgentTaskStatus[];
    limit?: number;
  }): Promise<AgentTaskRecord[]> { return agentTaskRepository.listAgentTasks(this.pool, input); }
  listStaleRunningAgentTasksWithoutActiveSandbox(input: { staleBefore: Date; limit?: number }): Promise<AgentTaskRecord[]> { return agentTaskRepository.listStaleRunningAgentTasksWithoutActiveSandbox(this.pool, input); }
  listTerminalAgentTasksNeedingNotification(limit = 20): Promise<AgentTaskRecord[]> { return agentTaskRepository.listTerminalAgentTasksNeedingNotification(this.pool, limit); }
  markAgentTaskNotified(taskId: string) { return agentTaskRepository.markAgentTaskNotified(this.pool, taskId); }
  listRenderableAgentTasks(limit = 20): Promise<AgentTaskRecord[]> { return agentTaskRepository.listRenderableAgentTasks(this.pool, limit); }
  markAgentTaskRendered(input: { taskId: string; signature: string; terminal: boolean }) { return agentTaskRepository.markAgentTaskRendered(this.pool, input); }
  markAgentTaskNotificationFailed(input: { taskId: string; error: string }) { return agentTaskRepository.markAgentTaskNotificationFailed(this.pool, input); }
  cancelAgentTask(input: { taskId: string; reason?: string | null }): Promise<boolean> { return agentTaskRepository.cancelAgentTask(this.pool, input); }
  recordSandboxCommandEvent(input: {
    taskId: string;
    sandboxRunId?: string | null;
    step: string;
    command?: string | null;
    exitCode?: number | null;
    outputTail?: string | null;
    errorTail?: string | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  }) { return agentTaskRepository.recordSandboxCommandEvent(this.pool, input); }
  getSandboxCommandEvents(input: {
    guildId: string;
    visibleChannelIds?: string[];
    taskId?: string;
    traceId?: string;
    limit?: number;
  }): Promise<SandboxCommandEvent[]> { return agentTaskRepository.getSandboxCommandEvents(this.pool, input); }
  getSandboxCommandEventsForTask(input: { taskId: string; limit?: number }): Promise<SandboxCommandEvent[]> { return agentTaskRepository.getSandboxCommandEventsForTask(this.pool, input); }
  listActiveSandboxRuns(input: { backend?: string; limit?: number } = {}): Promise<SandboxRunRecord[]> { return agentTaskRepository.listActiveSandboxRuns(this.pool, input); }
  getSandboxRunsForTask(taskId: string): Promise<SandboxRunRecord[]> { return agentTaskRepository.getSandboxRunsForTask(this.pool, taskId); }
  listTerminalSandboxRunsPendingCleanup(input: { backend?: string; limit?: number } = {}): Promise<SandboxRunRecord[]> { return agentTaskRepository.listTerminalSandboxRunsPendingCleanup(this.pool, input); }
  markSandboxRunCleanedUp(sandboxRunId: string) { return agentTaskRepository.markSandboxRunCleanedUp(this.pool, sandboxRunId); }
  findAgentTaskByDiscordMessageId(messageId: string): Promise<AgentTaskRecord | undefined> { return agentTaskRepository.findAgentTaskByDiscordMessageId(this.pool, messageId); }
  getAgentRuntimeTaskEvents(input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<TaskEvent[]> { return agentTaskRepository.getAgentRuntimeTaskEvents(this.pool, input); }
  getTaskProgressEvents(input: {
    guildId: string;
    visibleChannelIds: string[];
    traceId?: string;
    limit: number;
  }): Promise<TaskEvent[]> { return agentTaskRepository.getTaskProgressEvents(this.pool, input); }
  getAgentRuntimeEventsForTrace(input: { traceId: string; limit?: number }): Promise<AgentRuntimeEvent[]> { return agentTaskRepository.getAgentRuntimeEventsForTrace(this.pool, input); }
  getAgentRuntimeMessagesForTrace(input: { traceId: string; limit?: number }): Promise<AgentRuntimeMessage[]> { return agentTaskRepository.getAgentRuntimeMessagesForTrace(this.pool, input); }
  listAgentRuntimeChatExecutions(input: { limit?: number } = {}): Promise<AgentRuntimeChatExecution[]> { return agentTaskRepository.listAgentRuntimeChatExecutions(this.pool, input); }
  findAgentRuntimeChatExecutionByTraceId(traceId: string): Promise<AgentRuntimeChatExecution | undefined> { return agentTaskRepository.findAgentRuntimeChatExecutionByTraceId(this.pool, traceId); }
  getAgentRuntimeArtifactsForExecution(input: { executionId: string; sessionId: string }): Promise<AgentRuntimeArtifactRecord[]> { return agentTaskRepository.getAgentRuntimeArtifactsForExecution(this.pool, input); }
  getAgentRuntimeArtifact(input: { artifactId: string }): Promise<AgentRuntimeArtifactContent | undefined> { return agentTaskRepository.getAgentRuntimeArtifact(this.pool, input); }
  getAgentRuntimeTaskEventsForTask(input: { taskId: string; limit?: number }): Promise<TaskEvent[]> { return agentTaskRepository.getAgentRuntimeTaskEventsForTask(this.pool, input); }
  getTaskProgressEventsForTask(input: { taskId: string; limit?: number }): Promise<TaskEvent[]> { return agentTaskRepository.getTaskProgressEventsForTask(this.pool, input); }
  getAgentTaskMetrics(): Promise<{
    tasksByStatus: Array<{ status: string; count: number }>;
    agentTaskBacklog: Array<{ backend: string; status: string; count: number; oldestAgeSeconds: number }>;
    sandboxRunsByStatus: Array<{ status: string; count: number }>;
    sandboxLeases: Array<{ backend: string; status: string; count: number }>;
    taskPhaseDurations: Array<{ phase: string; count: number; avgMs: number; maxMs: number }>;
    sandboxCacheEvents: Array<{ cacheType: string; cacheStatus: string; count: number }>;
  }> { return agentTaskRepository.getAgentTaskMetrics(this.pool); }
  upsertGuild(input: { id: string; name?: string | null; raw?: unknown }) { return discordArchiveRepository.upsertGuild(this.pool, input); }
  upsertChannel(input: {
    id: string;
    guildId: string;
    parentId?: string | null;
    name?: string | null;
    type: number;
    isThread?: boolean;
    discordCreatedAt?: Date | null;
    lastMessageId?: string | null;
    topic?: string | null;
    ownerId?: string | null;
    archived?: boolean | null;
    archiveTimestamp?: Date | null;
    raw?: unknown;
  }) { return discordArchiveRepository.upsertChannel(this.pool, input); }
  upsertUser(input: {
    id: string;
    username?: string | null;
    globalName?: string | null;
    isBot?: boolean;
    raw?: unknown;
  }) { return discordArchiveRepository.upsertUser(this.pool, input); }
  upsertGuildMember(input: {
    guildId: string;
    userId: string;
    displayName?: string | null;
    nickname?: string | null;
    roles?: string[];
    joinedAt?: Date | null;
    raw?: unknown;
  }) { return discordArchiveRepository.upsertGuildMember(this.pool, input); }
  async upsertMessage(input: PersistedMessage) {
    const stored = await discordArchiveRepository.upsertMessage(this.pool, input);
    const usage = discordEmojiUsageRepository.emojiUsageEntriesFromMessage(input);
    if (stored.messageExisted || usage.length > 0) {
      await discordEmojiUsageRepository.replaceDiscordEmojiUsageForMessage(this.pool, input);
    }
    return stored;
  }
  async markMessageDeleted(messageId: string) {
    await discordArchiveRepository.markMessageDeleted(this.pool, messageId);
    await discordEmojiUsageRepository.clearDiscordEmojiUsageForMessage(this.pool, messageId);
  }
  setDiscordBugMarker(input: { guildId: string; channelId: string; messageId: string; userId: string; present: boolean }) { return discordBugMarkerRepository.setDiscordBugMarker(this.pool, input); }
  clearDiscordBugMarkersForMessage(input: { guildId: string; messageId: string }) { return discordBugMarkerRepository.clearDiscordBugMarkersForMessage(this.pool, input); }
  isUserPrivacyDeleted(userId: string) { return discordArchiveRepository.isUserPrivacyDeleted(this.pool, userId); }
  async requestUserDeletion(userId: string) {
    await discordArchiveRepository.requestUserDeletion(this.pool, userId);
    await discordEmojiUsageRepository.clearDiscordEmojiUsageForAuthor(this.pool, userId);
  }
  setChannelExcluded(input: {
    channelId: string;
    excluded: boolean;
    guildId?: string;
    parentId?: string | null;
    name?: string | null;
    type?: number;
    isThread?: boolean;
  }) { return discordArchiveRepository.setChannelExcluded(this.pool, input); }
  updateCrawlCursor(input: {
    guildId: string;
    channelId: string;
    beforeMessageId?: string | null;
    lastMessageId?: string | null;
    status: "pending" | "running" | "complete" | "error";
    error?: string | null;
    crawledCountIncrement?: number;
  }) { return discordArchiveRepository.updateCrawlCursor(this.pool, input); }
  ensureCrawlCursor(input: { guildId: string; channelId: string; status?: "pending" | "running" | "complete" | "error" }) { return discordArchiveRepository.ensureCrawlCursor(this.pool, input); }
  getCrawlStatus(guildId: string) { return discordArchiveRepository.getCrawlStatus(this.pool, guildId); }
  getCrawlCursor(channelId: string) { return discordArchiveRepository.getCrawlCursor(this.pool, channelId); }
  resetCrawlCursors(guildId: string) { return discordArchiveRepository.resetCrawlCursors(this.pool, guildId); }
  blockUserInteraction(input: { guildId: string; userId: string; reason?: string | null }) { return discordArchiveRepository.blockUserInteraction(this.pool, input); }
  unblockUserInteraction(input: { guildId: string; userId: string }): Promise<boolean> { return discordArchiveRepository.unblockUserInteraction(this.pool, input); }
  isUserInteractionBlocked(input: { guildId: string; userId: string }): Promise<boolean> { return discordArchiveRepository.isUserInteractionBlocked(this.pool, input); }
  listInteractionBlocks(guildId: string): Promise<InteractionBlock[]> { return discordArchiveRepository.listInteractionBlocks(this.pool, guildId); }
  interactionBlockCount(guildId: string): Promise<number> { return discordArchiveRepository.interactionBlockCount(this.pool, guildId); }
  upsertDiscordUserAlias(input: { guildId: string; userId: string; alias: string }) { return discordArchiveRepository.upsertDiscordUserAlias(this.pool, input); }
  deleteDiscordUserAlias(input: { guildId: string; alias: string }) { return discordArchiveRepository.deleteDiscordUserAlias(this.pool, input); }
  listDiscordUserAliases(input: { guildId: string; userId?: string; query?: string; limit?: number }) { return discordArchiveRepository.listDiscordUserAliases(this.pool, input); }
  getVisibleIndexedChannelIds(guildId: string, visibleChannelIds: string[]) { return retrievalRepository.getVisibleIndexedChannelIds(this.pool, guildId, visibleChannelIds); }
  listDiscordBugMarkers(input: { guildId: string; userId: string; visibleChannelIds: string[]; limit: number }): Promise<DiscordBugMarker[]> { return discordBugMarkerRepository.listDiscordBugMarkers(this.pool, input); }
  listDiscordEmojiCultureProfiles(input: { guildId: string; visibleChannelIds: string[]; emojiIds: string[]; queryText?: string; limit?: number }) { return discordEmojiUsageRepository.listDiscordEmojiCultureProfiles(this.pool, input); }
  keywordSearch(input: {
    guildId: string;
    visibleChannelIds: string[];
    query: string;
    limit: number;
    authorId?: string;
    authorIds?: string[];
    aboutUserTerms?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<SearchResult[]> { return retrievalRepository.keywordSearch(this.pool, input); }
  vectorSearch(input: {
    guildId: string;
    visibleChannelIds: string[];
    embedding: number[];
    limit: number;
    authorId?: string;
    authorIds?: string[];
    aboutUserTerms?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<SearchResult[]> { return retrievalRepository.vectorSearch(this.pool, input); }
  recentMessages(input: { guildId: string; channelId: string; limit: number; includeBots?: boolean }): Promise<SearchResult[]> { return retrievalRepository.recentMessages(this.pool, input); }
  recentMessagesFromChannels(input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    limit: number;
    authorIds?: string[];
    aboutUserTerms?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    includeBots?: boolean;
  }): Promise<SearchResult[]> { return retrievalRepository.recentMessagesFromChannels(this.pool, input); }
  sampleMessagesFromChannels(input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    limit: number;
    authorIds?: string[];
    aboutUserTerms?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    includeBots?: boolean;
  }): Promise<SearchResult[]> { return retrievalRepository.sampleMessagesFromChannels(this.pool, input); }
  getDiscordUserReferenceTerms(input: { guildId: string; userIds: string[] }): Promise<DiscordUserReferenceTerms[]> { return retrievalRepository.getDiscordUserReferenceTerms(this.pool, input); }
  findDiscordUsers(input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    limit: number;
  }): Promise<DiscordUserLookupResult[]> { return retrievalRepository.findDiscordUsers(this.pool, input); }
  findDiscordChannels(input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    limit: number;
  }): Promise<DiscordChannelLookupResult[]> { return retrievalRepository.findDiscordChannels(this.pool, input); }
  messageContext(input: {
    guildId: string;
    visibleChannelIds: string[];
    messageId: string;
    before: number;
    after: number;
  }): Promise<SearchResult[]> { return retrievalRepository.messageContext(this.pool, input); }
  searchDiscordAttachments(input: {
    guildId: string;
    visibleChannelIds: string[];
    query?: string;
    channelIds?: string[];
    authorIds?: string[];
    contentType?: string;
    limit: number;
  }): Promise<DiscordAttachmentSearchResult[]> { return retrievalRepository.searchDiscordAttachments(this.pool, input); }
  messageAttachments(input: {
    guildId: string;
    visibleChannelIds: string[];
    messageId: string;
    contentType?: string;
    limit: number;
  }): Promise<DiscordAttachmentSearchResult[]> { return retrievalRepository.messageAttachments(this.pool, input); }
  discordStats(input: {
    guildId: string;
    visibleChannelIds: string[];
    limit: number;
    authorIds?: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    groupBy?: DiscordStatsGroupBy;
    metric?: DiscordStatsMetric;
    includeBots?: boolean;
    sort?: DiscordStatsSort;
    query?: string;
    attachmentContentType?: string;
  }): Promise<DiscordStats> { return retrievalRepository.discordStats(this.pool, input); }
  discordChannelTopicCandidates(input: {
    guildId: string;
    visibleChannelIds: string[];
    channelIds?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    channelLimit: number;
    samplesPerChannel: number;
    minChannelMessages: number;
    minMessageChars: number;
    includeBots?: boolean;
  }): Promise<DiscordChannelTopicCandidate[]> { return retrievalRepository.discordChannelTopicCandidates(this.pool, input); }
}

function rowToRunFeedback(row: any): AgentRunFeedback {
  return {
    runId: String(row.run_id),
    rating: String(row.rating) as AgentRunFeedback["rating"],
    note: row.note == null ? null : String(row.note),
    expectedBehavior: row.expected_behavior == null ? null : String(row.expected_behavior),
    captureEval: Boolean(row.capture_eval),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
