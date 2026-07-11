import type {
  AgentRuntimeEvent,
  AgentRuntimeArtifactRecord,
  AgentRuntimeChatExecution,
  AgentRuntimeMessage,
  AgentTaskRecord,
  DiscordAiAgentRepository,
  ProcessRunArtifactRecord,
  ProcessRunEventRecord,
  ProcessRunKind,
  ProcessRunRecord,
  ProcessRunSpanRecord,
  ProcessRunStatus,
  SandboxCommandEvent,
  SandboxRunRecord,
  TaskEvent,
  ToolAuditLog,
  TraceEvent
} from "../db/repositories.js";
import { runtimeEventCategory, runtimeEventPhase, type RuntimeEventCategory, type RuntimeEventPhase } from "./runtimeEventSchema.js";

export type RunSummary = {
  runId: string;
  traceId: string | null;
  kind: ProcessRunKind;
  status: ProcessRunStatus;
  title: string;
  summary: string | null;
  requester: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  messageId: string | null;
  source: string;
  startedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
  durationMs: number | null;
  currentStep: string | null;
  bottleneck: { name: string; durationMs: number } | null;
  links: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type RunSpan = {
  id: string;
  source: "process" | "task" | "sandbox" | "command" | "runtime";
  name: string;
  status: ProcessRunStatus;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
};

export type RunEvent = {
  id: string;
  source: "process" | "trace" | "runtime" | "task" | "tool" | "command";
  level: "debug" | "info" | "warn" | "error";
  name: string;
  summary: string | null;
  createdAt: Date;
  durationMs: number | null;
  category?: RuntimeEventCategory;
  phase?: RuntimeEventPhase;
  spanId?: string | null;
  parentSpanId?: string | null;
  metadata: Record<string, unknown>;
};

export type RunArtifactSummary = ProcessRunArtifactRecord;

export type RunAgentTranscriptMessage = {
  id: string;
  sessionId: string;
  clientMessageId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  parts: unknown[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type RunTerminalEntry = {
  id: string;
  source: "command";
  stream: "command" | "stdout" | "stderr" | "exit";
  step: string;
  command: string | null;
  createdAt: Date;
  content: string;
};

export type RunSnapshot = {
  run: RunSummary;
  spans: RunSpan[];
  events: RunEvent[];
  artifacts: RunArtifactSummary[];
  terminal: {
    lineCount: number;
    content: string;
    entries: RunTerminalEntry[];
  };
  diagnostics: string[];
  raw: {
    processRun?: ProcessRunRecord;
    task?: AgentTaskRecord;
    sandboxRuns: SandboxRunRecord[];
  };
  agentTranscript: RunAgentTranscriptMessage[];
  relatedRuns: RunSummary[];
  generatedAt: Date;
};

export type RunResolution = {
  run: RunSummary;
  messageId: string;
};

export async function listRunSummaries(repo: DiscordAiAgentRepository, input: { limit?: number; includeEmbeddings?: boolean } = {}): Promise<RunSummary[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  const [processRuns, tasks, chatExecutions] = await Promise.all([
    repo.listProcessRuns({ limit, includeEmbeddings: input.includeEmbeddings ?? true }),
    repo.listRecentAgentTasks(limit),
    typeof repo.listAgentRuntimeChatExecutions === "function" ? repo.listAgentRuntimeChatExecutions({ limit }) : Promise.resolve([])
  ]);
  const byId = new Map<string, RunSummary>();
  for (const run of processRuns) byId.set(run.runId, summaryFromProcessRun(run));
  for (const task of tasks) {
    if (!byId.has(task.taskId)) byId.set(task.taskId, summaryFromTask(task));
  }
  for (const execution of chatExecutions) {
    const summary = summaryFromAgentExecution(execution);
    if (!byId.has(summary.runId)) byId.set(summary.runId, summary);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()).slice(0, limit);
}

export async function resolveRunReference(repo: DiscordAiAgentRepository, input: string): Promise<RunResolution | undefined> {
  const messageId = extractDiscordMessageId(input);
  if (!messageId) return undefined;

  const processRun = await repo.findProcessRunByDiscordMessageId(messageId);
  if (processRun) return { run: summaryFromProcessRun(processRun), messageId };

  const task = await repo.findAgentTaskByDiscordMessageId(messageId);
  if (task) return { run: summaryFromTask(task), messageId };

  const execution =
    typeof repo.findAgentRuntimeChatExecutionByTraceId === "function"
      ? await repo.findAgentRuntimeChatExecutionByTraceId(messageId)
      : undefined;
  if (execution) return { run: summaryFromAgentExecution(execution), messageId };

  return undefined;
}

export function extractDiscordMessageId(input: string): string | null {
  const value = input.trim();
  if (/^\d{15,25}$/.test(value)) return value;

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const channelsIndex = parts.indexOf("channels");
    const messageId = channelsIndex >= 0 ? parts[channelsIndex + 3] : parts.at(-1);
    if (messageId && /^\d{15,25}$/.test(messageId)) return messageId;
  } catch {
    // Fall through to a permissive pasted-text scan below.
  }

  const matches = value.match(/\d{15,25}/g);
  return matches?.at(-1) ?? null;
}

export async function getRunSnapshot(repo: DiscordAiAgentRepository, runId: string): Promise<RunSnapshot | undefined> {
  const [processRun, task] = await Promise.all([repo.getProcessRun(runId), repo.getAgentTask(runId)]);
  const chatExecution =
    !processRun && !task && typeof repo.findAgentRuntimeChatExecutionByTraceId === "function"
      ? await repo.findAgentRuntimeChatExecutionByTraceId(runId)
      : undefined;
  if (!processRun && !task && !chatExecution) return undefined;

  const traceId = processRun?.traceId ?? task?.traceId ?? chatExecution?.traceId ?? chatExecution?.sessionTraceId ?? runId;
  const parentAgentExecutionId = processRun ? agentExecutionIdFromProcessRun(processRun) : null;
  const originAgentExecutionId = processRun ? parentAgentExecutionIdFromProcessRun(processRun) : null;
  const [
    processSpans,
    processEvents,
    processArtifacts,
    runtimeArtifacts,
    taskEvents,
    commands,
    sandboxRuns,
    traceEvents,
    runtimeEvents,
    runtimeMessages,
    toolLogs,
    relatedProcessRuns,
    parentProcessRun,
    childProcessRuns,
    relatedTasks
  ] = await Promise.all([
    processRun ? repo.getProcessRunSpans(processRun.runId) : Promise.resolve([]),
    processRun ? repo.getProcessRunEvents({ runId: processRun.runId, limit: 500 }) : Promise.resolve([]),
    processRun ? repo.getProcessRunArtifacts(processRun.runId) : Promise.resolve([]),
    chatExecution && typeof repo.getAgentRuntimeArtifactsForExecution === "function"
      ? repo.getAgentRuntimeArtifactsForExecution({ executionId: chatExecution.executionId, sessionId: chatExecution.sessionId })
      : Promise.resolve([]),
    task ? repo.getTaskProgressEventsForTask({ taskId: task.taskId, limit: 300 }) : Promise.resolve([]),
    task ? repo.getSandboxCommandEventsForTask({ taskId: task.taskId, limit: 100 }) : Promise.resolve([]),
    task ? repo.getSandboxRunsForTask(task.taskId) : Promise.resolve([]),
    traceId ? repo.getTraceEventsForTrace({ traceId, limit: 500 }) : Promise.resolve([]),
    traceId ? repo.getAgentRuntimeEventsForTrace({ traceId, limit: 500 }) : Promise.resolve([]),
    traceId ? repo.getAgentRuntimeMessagesForTrace({ traceId, limit: 150 }) : Promise.resolve([]),
    traceId ? repo.getToolAuditLogsForTrace({ traceId, limit: 200 }) : Promise.resolve([]),
    traceId ? repo.listProcessRunsForTrace({ traceId, limit: 20 }) : Promise.resolve([]),
    originAgentExecutionId ? repo.findProcessRunByAgentExecutionId(originAgentExecutionId) : Promise.resolve(undefined),
    parentAgentExecutionId ? repo.listProcessRunsByParentAgentExecutionId({ parentAgentExecutionId, limit: 20 }) : Promise.resolve([]),
    traceId ? repo.listAgentTasksForTrace({ traceId, limit: 20 }) : Promise.resolve([])
  ]);

  const runtimeScope = runtimeSnapshotScope({ traceId, runId, processRun, task, chatExecution });
  const scopedRuntimeEvents = runtimeEvents.filter((event) => runtimeEventMatchesScope(event, runtimeScope));
  const scopedRuntimeMessages = runtimeMessages.filter((message) => runtimeMessageMatchesScope(message, runtimeScope));

  const spans = sortSpans([
    ...processSpans.map(spanFromProcess),
    ...scopedRuntimeEvents.flatMap(spanFromRuntimeEvent),
    ...taskEvents.flatMap(spansFromTaskEvent),
    ...sandboxRuns.map(spanFromSandboxRun),
    ...commands.map(spanFromCommand)
  ]);
  const run = processRun ? summaryFromProcessRun(processRun, spans) : task ? summaryFromTask(task, spans) : summaryFromAgentExecution(chatExecution!, spans);
  const events = sortEvents([
    ...processEvents.map(eventFromProcess),
    ...traceEvents.map(eventFromTrace),
    ...scopedRuntimeEvents.map(eventFromRuntime),
    ...taskEvents.map(eventFromTask),
    ...toolLogs.map(eventFromTool),
    ...commands.map(eventFromCommand)
  ]);
  const terminal = terminalFromCommands(commands);
  return {
    run,
    spans,
    events,
    artifacts: [...processArtifacts, ...runtimeArtifacts.map(artifactFromRuntime)],
    terminal,
    diagnostics: diagnosticsForRun(run, spans, events),
    raw: { processRun, task, sandboxRuns },
    agentTranscript: scopedRuntimeMessages.map(agentTranscriptMessageFromRuntime),
    relatedRuns: relatedRunSummaries({
      processRun,
      task,
      relatedProcessRuns: [...relatedProcessRuns, ...(parentProcessRun ? [parentProcessRun] : []), ...childProcessRuns],
      relatedTasks
    }),
    generatedAt: new Date()
  };
}

type RuntimeSnapshotScope = {
  traceId: string;
  messageIds: Set<string>;
  taskIds: Set<string>;
  executionIds: Set<string>;
};

function runtimeSnapshotScope(input: {
  traceId: string;
  runId: string;
  processRun?: ProcessRunRecord;
  task?: AgentTaskRecord;
  chatExecution?: AgentRuntimeChatExecution;
}): RuntimeSnapshotScope {
  const messageIds = new Set<string>();
  const taskIds = new Set<string>();
  const executionIds = new Set<string>();

  addSetValue(messageIds, input.traceId);
  addSetValue(messageIds, input.runId);
  addSetValue(messageIds, input.processRun?.messageId);
  addSetValue(messageIds, input.task?.traceId);
  addSetValue(messageIds, input.task?.discordResponseMessageId);
  addSetValue(messageIds, input.chatExecution?.traceId);
  addSetValue(messageIds, input.chatExecution?.sessionTraceId);
  addSetValue(messageIds, stringMetadata(input.chatExecution?.metadata.discordMessageId));
  addSetValue(messageIds, stringMetadata(input.processRun?.metadata.currentMessageId));
  addSetValue(messageIds, stringMetadata(input.processRun?.metadata.discordMessageId));
  addSetValue(messageIds, stringMetadata(input.processRun?.metadata.discordResponseMessageId));
  addSetValue(messageIds, stringMetadata(input.processRun?.metadata.replyMessageId));

  for (const value of Object.values(input.processRun?.links ?? {})) {
    if (typeof value === "string") addSetValue(messageIds, extractDiscordMessageId(value));
  }

  addSetValue(taskIds, input.task?.taskId);
  addSetValue(taskIds, input.processRun?.runId?.startsWith("task-") ? input.processRun.runId : null);
  addSetValue(taskIds, stringMetadata(input.processRun?.metadata.taskId));

  addSetValue(executionIds, agentExecutionIdFromProcessRun(input.processRun));
  addSetValue(executionIds, parentAgentExecutionIdFromProcessRun(input.processRun));
  addSetValue(executionIds, stringMetadata(input.processRun?.metadata.executionId));
  addSetValue(executionIds, stringMetadata(input.processRun?.metadata.agentRuntimeExecutionId));
  addSetValue(executionIds, input.chatExecution?.executionId);
  addSetValue(executionIds, `agent-execution-${input.traceId}`);
  for (const taskId of taskIds) addSetValue(executionIds, `agent-task-execution-${taskId}`);

  return { traceId: input.traceId, messageIds, taskIds, executionIds };
}

function runtimeEventMatchesScope(event: AgentRuntimeEvent, scope: RuntimeSnapshotScope) {
  if (event.traceId === scope.traceId) return true;
  if (event.executionId && scope.executionIds.has(event.executionId)) return true;
  if (metadataMatchesScope(event.metadata, scope)) return true;
  return false;
}

function runtimeMessageMatchesScope(message: AgentRuntimeMessage, scope: RuntimeSnapshotScope) {
  const clientMessageId = message.clientMessageId;
  if (clientMessageId && scope.messageIds.has(clientMessageId)) return true;
  if (clientMessageId?.startsWith(`${scope.traceId}:transcript:`)) return true;
  if (clientMessageId && scope.taskIds.has(clientMessageId)) return true;
  if (metadataMatchesScope(message.metadata, scope)) return true;
  return false;
}

function metadataMatchesScope(metadata: Record<string, unknown>, scope: RuntimeSnapshotScope) {
  const metadataMessageIds = [
    stringMetadata(metadata.traceId),
    stringMetadata(metadata.promptMessageId),
    stringMetadata(metadata.discordMessageId),
    stringMetadata(metadata.messageId),
    stringMetadata(metadata.runId),
    stringMetadata(metadata.replyMessageId)
  ];
  if (metadataMessageIds.some((value) => value === scope.traceId || (value != null && scope.messageIds.has(value)))) return true;

  const metadataTaskId = stringMetadata(metadata.taskId);
  if (metadataTaskId && scope.taskIds.has(metadataTaskId)) return true;

  const metadataExecutionIds = [
    stringMetadata(metadata.executionId),
    stringMetadata(metadata.agentExecutionId),
    stringMetadata(metadata.agentRuntimeExecutionId),
    stringMetadata(metadata.parentAgentExecutionId),
    stringMetadata(metadata.parentExecutionId)
  ];
  return metadataExecutionIds.some((value) => value != null && scope.executionIds.has(value));
}

function addSetValue(set: Set<string>, value: string | null | undefined) {
  if (value) set.add(value);
}

function agentTranscriptMessageFromRuntime(message: AgentRuntimeMessage): RunAgentTranscriptMessage {
  return {
    id: message.messageId,
    sessionId: message.sessionId,
    clientMessageId: message.clientMessageId,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata,
    createdAt: message.createdAt
  };
}

function agentExecutionIdFromProcessRun(run: ProcessRunRecord | undefined) {
  if (!run) return null;
  const direct = stringMetadata(run.metadata.agentExecutionId);
  if (direct) return direct;
  return stringMetadata(run.metadata.agentRuntimeExecutionId);
}

function parentAgentExecutionIdFromProcessRun(run: ProcessRunRecord | undefined) {
  if (!run) return null;
  const direct = stringMetadata(run.metadata.parentAgentExecutionId);
  if (direct) return direct;
  return stringMetadata(run.metadata.parentExecutionId);
}

export function relatedRunSummaries(input: {
  processRun?: ProcessRunRecord;
  task?: AgentTaskRecord;
  relatedProcessRuns: ProcessRunRecord[];
  relatedTasks: AgentTaskRecord[];
}): RunSummary[] {
  const currentIds = new Set([input.processRun?.runId, input.task?.taskId].filter((value): value is string => Boolean(value)));
  const byId = new Map<string, RunSummary>();
  for (const run of input.relatedProcessRuns) {
    if (currentIds.has(run.runId)) continue;
    byId.set(run.runId, summaryFromProcessRun(run));
  }
  for (const task of input.relatedTasks) {
    if (currentIds.has(task.taskId) || byId.has(task.taskId)) continue;
    byId.set(task.taskId, summaryFromTask(task));
  }
  return [...byId.values()].sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
}

export function summaryFromProcessRun(run: ProcessRunRecord, spans: RunSpan[] = []): RunSummary {
  return {
    runId: run.runId,
    traceId: run.traceId,
    kind: run.kind,
    status: run.status,
    title: run.title,
    summary: run.summary,
    requester: run.requester,
    guildId: run.guildId,
    channelId: run.channelId,
    userId: run.userId,
    messageId: run.messageId,
    source: run.source,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
    durationMs: durationBetween(run.startedAt, run.completedAt ?? (isTerminal(run.status) ? run.updatedAt : null)),
    currentStep: typeof run.metadata.currentStep === "string" ? run.metadata.currentStep : null,
    bottleneck: bottleneckSpan(spans),
    links: run.links,
    metadata: run.metadata
  };
}

export function summaryFromTask(task: AgentTaskRecord, spans: RunSpan[] = []): RunSummary {
  return {
    runId: task.taskId,
    traceId: task.traceId,
    kind: "codegen",
    status: task.status,
    title: task.title,
    summary: task.error ?? task.statusMessage,
    requester: task.requestedBy,
    guildId: task.guildId,
    channelId: task.channelId,
    userId: task.userId,
    messageId: null,
    source: "agent_task",
    startedAt: task.startedAt ?? task.createdAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    durationMs: durationBetween(task.startedAt ?? task.createdAt, task.completedAt ?? (isTerminal(task.status) ? task.updatedAt : null)),
    currentStep: task.currentStep,
    bottleneck: bottleneckSpan(spans),
    links: { pullRequest: task.prUrl, branch: task.branchName },
    metadata: {
      request: task.request,
      backend: task.backend,
      draft: task.draft,
      verifyPassed: task.verifyPassed,
      notificationError: task.notificationError
    }
  };
}

export function summaryFromAgentExecution(execution: AgentRuntimeChatExecution, spans: RunSpan[] = []): RunSummary {
  const traceId = execution.traceId ?? execution.sessionTraceId ?? stringMetadata(execution.metadata.discordMessageId) ?? execution.executionId;
  const replyUrl = stringMetadata(execution.metadata.replyUrl);
  const discordUrl = stringMetadata(execution.metadata.discordUrl) ?? stringMetadata(execution.sessionMetadata.discordUrl);
  return {
    runId: traceId,
    traceId,
    kind: "discord",
    status: execution.status,
    title: execution.title,
    summary: execution.error ?? (execution.status === "succeeded" ? "Discord prompt execution succeeded." : execution.request.slice(0, 200) || null),
    requester: execution.requestedBy,
    guildId: execution.guildId,
    channelId: execution.channelId,
    userId: execution.userId,
    messageId: stringMetadata(execution.metadata.discordMessageId) ?? traceId,
    source: "agent_runtime",
    startedAt: execution.startedAt ?? execution.createdAt,
    completedAt: execution.completedAt,
    updatedAt: execution.updatedAt,
    durationMs: durationBetween(execution.startedAt ?? execution.createdAt, execution.completedAt ?? (isTerminal(execution.status) ? execution.updatedAt : null)),
    currentStep: null,
    bottleneck: bottleneckSpan(spans),
    links: { discordMessage: discordUrl, discordReply: replyUrl },
    metadata: { ...execution.sessionMetadata, ...execution.metadata, sessionId: execution.sessionId, executionId: execution.executionId }
  };
}

function spanFromProcess(span: ProcessRunSpanRecord): RunSpan {
  return {
    id: `process-${span.id}`,
    source: "process",
    name: span.name,
    status: span.status,
    startedAt: span.startedAt,
    completedAt: span.completedAt,
    durationMs: span.durationMs,
    metadata: { spanId: span.spanId, parentSpanId: span.parentSpanId, ...span.metadata }
  };
}

function spansFromTaskEvent(event: TaskEvent): RunSpan[] {
  const step = typeof event.metadata.step === "string" ? event.metadata.step : null;
  const durationMs = typeof event.metadata.durationMs === "number" ? event.metadata.durationMs : null;
  if (!step || durationMs == null || (!step.endsWith("_complete") && !step.endsWith("_failed"))) return [];
  const name = step.replace(/_(complete|failed)$/, "");
  return [
    {
      id: `task-${event.id}`,
      source: "task",
      name,
      status: step.endsWith("_failed") ? "failed" : "succeeded",
      startedAt: new Date(event.createdAt.getTime() - durationMs),
      completedAt: event.createdAt,
      durationMs,
      metadata: event.metadata
    }
  ];
}

function spanFromSandboxRun(run: SandboxRunRecord): RunSpan {
  return {
    id: `sandbox-${run.sandboxRunId}`,
    source: "sandbox",
    name: run.backend,
    status: normalizeStatus(run.status),
    startedAt: run.startedAt ?? run.updatedAt,
    completedAt: run.completedAt,
    durationMs: durationBetween(run.startedAt ?? run.updatedAt, run.completedAt),
    metadata: {
      sandboxRunId: run.sandboxRunId,
      namespace: run.namespace,
      backendJobName: run.backendJobName,
      image: run.image,
      cleanedUpAt: run.cleanedUpAt,
      ...run.metadata
    }
  };
}

function spanFromCommand(command: SandboxCommandEvent): RunSpan {
  return {
    id: `command-${command.id}`,
    source: "command",
    name: command.step,
    status: command.exitCode == null ? "running" : command.exitCode === 0 ? "succeeded" : "failed",
    startedAt: command.durationMs == null ? command.createdAt : new Date(command.createdAt.getTime() - command.durationMs),
    completedAt: command.createdAt,
    durationMs: command.durationMs,
    metadata: {
      command: command.command,
      exitCode: command.exitCode,
      sandboxRunId: command.sandboxRunId,
      stdoutChars: command.outputTail.length,
      stderrChars: command.errorTail.length
    }
  };
}

function spanFromRuntimeEvent(event: AgentRuntimeEvent): RunSpan[] {
  const span = event.metadata.span;
  if ((!span || typeof span !== "object") && event.spanId && event.durationMs != null && event.metadata.category === "model" && event.metadata.phase !== "started") {
    return [{
      id: `runtime-model-${event.id}`,
      source: "runtime",
      name: typeof event.metadata.purpose === "string" ? `model.${event.metadata.purpose}` : event.eventName,
      status: event.level === "error" ? "failed" : "succeeded",
      startedAt: new Date(event.createdAt.getTime() - event.durationMs),
      completedAt: event.createdAt,
      durationMs: event.durationMs,
      metadata: { ...event.metadata, executionId: event.executionId, spanId: event.spanId, parentSpanId: event.parentSpanId }
    }];
  }
  if (!span || typeof span !== "object") return [];
  const data = span as Record<string, unknown>;
  const startedAt = typeof data.startedAt === "string" ? new Date(data.startedAt) : event.createdAt;
  const completedAt = typeof data.completedAt === "string" ? new Date(data.completedAt) : null;
  return [
    {
      id: `runtime-${event.id}`,
      source: "runtime",
      name: typeof data.name === "string" ? data.name : event.summary ?? event.eventName,
      status: normalizeStatus(typeof data.status === "string" ? data.status : "running"),
      startedAt,
      completedAt,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : event.durationMs,
      metadata: {
        executionId: event.executionId,
        spanId: event.spanId ?? data.spanId,
        parentSpanId: event.parentSpanId ?? data.parentSpanId,
        ...(typeof data.metadata === "object" && data.metadata ? (data.metadata as Record<string, unknown>) : {})
      }
    }
  ];
}

function artifactFromRuntime(artifact: AgentRuntimeArtifactRecord): ProcessRunArtifactRecord {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.executionId ?? artifact.sessionId,
    kind: artifact.kind as ProcessRunArtifactRecord["kind"],
    name: artifact.name,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    preview: artifact.preview,
    redacted: artifact.redacted,
    expiresAt: artifact.expiresAt,
    metadata: { sessionId: artifact.sessionId, executionId: artifact.executionId, ...artifact.metadata },
    createdAt: artifact.createdAt
  };
}

function eventFromProcess(event: ProcessRunEventRecord): RunEvent {
  return {
    ...eventDimensions(event.eventName, event.metadata),
    id: `process-${event.id}`,
    source: "process",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    metadata: event.metadata
  };
}

function eventFromTrace(event: TraceEvent): RunEvent {
  return {
    ...eventDimensions(event.eventName, event.metadata),
    id: `trace-${event.id}`,
    source: "trace",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    metadata: { requestId: event.requestId, messageId: event.messageId, ...event.metadata }
  };
}

function eventFromRuntime(event: AgentRuntimeEvent): RunEvent {
  return {
    ...eventDimensions(event.eventName, event.metadata, event.kind, event.spanId, event.parentSpanId),
    id: `runtime-${event.id}`,
    source: "runtime",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    metadata: {
      sessionId: event.sessionId,
      executionId: event.executionId,
      runtimeKind: event.kind,
      ...event.metadata
    }
  };
}

function eventFromTask(event: TaskEvent): RunEvent {
  return {
    ...eventDimensions(event.eventName, event.metadata, "task"),
    id: `task-${event.id}`,
    source: "task",
    level: event.level,
    name: event.eventName,
    summary: event.summary,
    createdAt: event.createdAt,
    durationMs: typeof event.metadata.durationMs === "number" ? event.metadata.durationMs : null,
    metadata: event.metadata
  };
}

function eventFromTool(log: ToolAuditLog): RunEvent {
  return {
    ...eventDimensions(log.toolName, {}, "tool"),
    id: `tool-${log.id}`,
    source: "tool",
    level: log.error ? "error" : "info",
    name: log.toolName,
    summary: log.error ?? log.resultSummary ?? log.argumentsSummary,
    createdAt: log.createdAt,
    durationMs: null,
    metadata: {
      argumentsSummary: log.argumentsSummary,
      resultSummary: log.resultSummary,
      error: log.error,
      model: log.model,
      estimatedCostUsd: log.estimatedCostUsd
    }
  };
}

function eventFromCommand(command: SandboxCommandEvent): RunEvent {
  return {
    ...eventDimensions(command.step, {}, "command"),
    id: `command-${command.id}`,
    source: "command",
    level: command.exitCode === 0 || command.exitCode == null ? "info" : "error",
    name: command.step,
    summary: `${command.command ?? command.step}${command.exitCode == null ? "" : ` exited ${command.exitCode}`}`,
    createdAt: command.createdAt,
    durationMs: command.durationMs,
    metadata: {
      command: command.command,
      exitCode: command.exitCode,
      stdoutTail: command.outputTail,
      stderrTail: command.errorTail
    }
  };
}

function eventDimensions(
  eventName: string,
  metadata: Record<string, unknown>,
  kind?: string | null,
  spanId?: string | null,
  parentSpanId?: string | null,
) {
  const metadataCategory = metadata.category;
  const category = typeof metadataCategory === "string"
    ? metadataCategory as RuntimeEventCategory
    : runtimeEventCategory(eventName, kind);
  const metadataPhase = metadata.phase;
  const phase = typeof metadataPhase === "string"
    ? metadataPhase as RuntimeEventPhase
    : runtimeEventPhase(eventName, metadata);
  return { category, phase, spanId: spanId ?? null, parentSpanId: parentSpanId ?? null };
}

function terminalFromCommands(commands: SandboxCommandEvent[]) {
  const entries: RunTerminalEntry[] = [];
  for (const command of commands) {
    entries.push({
      id: `command-${command.id}-cmd`,
      source: "command",
      stream: "command",
      step: command.step,
      command: command.command,
      createdAt: command.createdAt,
      content: `$ ${command.command ?? command.step}`
    });
    if (command.outputTail.trim()) {
      entries.push({
        id: `command-${command.id}-stdout`,
        source: "command",
        stream: "stdout",
        step: command.step,
        command: command.command,
        createdAt: command.createdAt,
        content: command.outputTail.trimEnd()
      });
    }
    if (command.errorTail.trim()) {
      entries.push({
        id: `command-${command.id}-stderr`,
        source: "command",
        stream: "stderr",
        step: command.step,
        command: command.command,
        createdAt: command.createdAt,
        content: command.errorTail.trimEnd()
      });
    }
    if (command.exitCode != null) {
      entries.push({
        id: `command-${command.id}-exit`,
        source: "command",
        stream: "exit",
        step: command.step,
        command: command.command,
        createdAt: command.createdAt,
        content: `[exit ${command.exitCode} in ${formatDuration(command.durationMs)}]`
      });
    }
  }
  const content = entries.map((entry) => entry.content).join("\n\n");
  return { content, lineCount: content ? content.split("\n").length : 0, entries };
}

export function diagnosticsForRun(run: RunSummary, spans: RunSpan[], events: RunEvent[]): string[] {
  const diagnostics: string[] = [];
  diagnostics.push(...codegenDiagnosticsForRun(run, events));
  const bottleneck = bottleneckSpan(spans);
  if (bottleneck) diagnostics.push(`Most time was spent in ${bottleneck.name}: ${formatDuration(bottleneck.durationMs)}.`);
  const failureEvent = [...events].reverse().find((event) => event.level === "error");
  const failure = failureEvent?.summary ?? (run.status === "failed" ? run.summary : null);
  if (failure) diagnostics.push(`Latest failure signal: ${failure}`);
  if (!isTerminal(run.status)) diagnostics.push(`Currently active at ${run.currentStep ?? "running"}.`);
  if (run.kind === "embedding" && typeof run.metadata.backlog === "number") {
    diagnostics.push(`Embedding backlog at run time: ${run.metadata.backlog}.`);
  }
  return diagnostics;
}

function codegenDiagnosticsForRun(run: RunSummary, events: RunEvent[]) {
  if (run.kind !== "codegen") return [];
  const diagnostics: string[] = [];
  const failureDiagnosis = codegenFailureDiagnosisFromMetadata(run.metadata.failureDiagnosis);
  if (failureDiagnosis) {
    diagnostics.push(`Failure diagnosis: ${failureDiagnosis.summary}`);
    if (failureDiagnosis.nextAction) diagnostics.push(`Suggested next action: ${failureDiagnosis.nextAction}`);
  }
  const firstDiff = [...events].reverse().find((event) => {
    const step = eventMetadataStep(event);
    return step === "codex_first_diff" || step === "codex_app_server_first_diff" || step === "opencode_first_diff" || step === "opencode_first_edit";
  });
  const noDiff = [...events]
    .reverse()
    .find((event) => eventMetadataStep(event).endsWith("_no_diff") || run.status === "no_changes");
  if (noDiff) {
    diagnostics.push("Coding agent finished without leaving a code diff.");
  } else if (!isTerminal(run.status) && !firstDiff) {
    diagnostics.push("Coding agent is running; inspect the latest harness, tool, and command events for live progress.");
  } else if (firstDiff) {
    const durationMs = numberFromUnknown(firstDiff.metadata.durationMs);
    diagnostics.push(`First visible edit appeared${durationMs == null ? "" : ` after ${formatDuration(durationMs)}`}.`);
  }
  return diagnostics;
}

function codegenFailureDiagnosisFromMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : null;
  if (!summary) return null;
  const nextAction = typeof record.nextAction === "string" && record.nextAction.trim() ? record.nextAction.trim() : null;
  return { summary, nextAction };
}

function eventMetadataStep(event: RunEvent) {
  const step = event.metadata.step;
  return typeof step === "string" ? step : event.name;
}

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bottleneckSpan(spans: RunSpan[]) {
  const span = spans
    .filter((item) => item.durationMs != null)
    .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))[0];
  return span && span.durationMs != null ? { name: span.name, durationMs: span.durationMs } : null;
}

function sortSpans(spans: RunSpan[]) {
  return spans.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
}

function sortEvents(events: RunEvent[]) {
  const seen = new Set<string>();
  return events
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .filter((event) => {
      const key = `${event.source}:${event.name}:${event.createdAt.toISOString()}:${event.summary ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeStatus(status: string): ProcessRunStatus {
  if (status === "queued" || status === "running" || status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled") {
    return status;
  }
  if (status === "complete" || status === "completed") return "succeeded";
  if (status === "error") return "failed";
  return "running";
}

function isTerminal(status: ProcessRunStatus) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}

function durationBetween(start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "unknown";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
