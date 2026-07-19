import type {
  AgentRuntimeChatExecution,
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  AgentTaskRecord,
  DiscordAiAgentRepository,
  ProcessRunRecord,
  SandboxCommandEvent,
} from "../db/repositories.js";
import {
  artifactFromRuntime,
  eventFromCommand,
  eventFromProcess,
  eventFromRuntime,
  eventFromTask,
  eventFromTool,
  eventFromTrace,
  spanFromCommand,
  spanFromProcess,
  spanFromRuntimeEvent,
  spanFromSandboxRun,
  spansFromTaskEvent,
  stringMetadata,
  summaryFromAgentExecution,
  summaryFromProcessRun,
  summaryFromTask,
} from "./runRecordMappers.js";
import { bottleneckSpan, isTerminal } from "./runSummaryValues.js";
import type {
  RunAgentTranscriptMessage,
  RunEvent,
  RunResolution,
  RunSnapshot,
  RunSpan,
  RunSummary,
  RunTerminalEntry,
} from "./runTypes.js";

export async function listRunSummaries(
  repo: DiscordAiAgentRepository,
  input: { limit?: number; includeEmbeddings?: boolean } = {},
): Promise<RunSummary[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  const [processRuns, tasks, chatExecutions] = await Promise.all([
    repo.listProcessRuns({
      limit,
      includeEmbeddings: input.includeEmbeddings ?? true,
    }),
    repo.listRecentAgentTasks(limit),
    typeof repo.listAgentRuntimeChatExecutions === "function"
      ? repo.listAgentRuntimeChatExecutions({ limit })
      : Promise.resolve([]),
  ]);
  const byId = new Map<string, RunSummary>();
  for (const run of processRuns)
    byId.set(run.runId, summaryFromProcessRun(run));
  for (const task of tasks) {
    if (!byId.has(task.taskId)) byId.set(task.taskId, summaryFromTask(task));
  }
  for (const execution of chatExecutions) {
    const summary = summaryFromAgentExecution(execution);
    if (!byId.has(summary.runId)) byId.set(summary.runId, summary);
  }
  return [...byId.values()]
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .slice(0, limit);
}

export async function resolveRunReference(
  repo: DiscordAiAgentRepository,
  input: string,
): Promise<RunResolution | undefined> {
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
  if (execution)
    return { run: summaryFromAgentExecution(execution), messageId };

  return undefined;
}

export function extractDiscordMessageId(input: string): string | null {
  const value = input.trim();
  if (/^\d{15,25}$/.test(value)) return value;

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const channelsIndex = parts.indexOf("channels");
    const messageId =
      channelsIndex >= 0 ? parts[channelsIndex + 3] : parts.at(-1);
    if (messageId && /^\d{15,25}$/.test(messageId)) return messageId;
  } catch {
    // Fall through to a permissive pasted-text scan below.
  }

  const matches = value.match(/\d{15,25}/g);
  return matches?.at(-1) ?? null;
}

export async function getRunSnapshot(
  repo: DiscordAiAgentRepository,
  runId: string,
): Promise<RunSnapshot | undefined> {
  const [processRun, task] = await Promise.all([
    repo.getProcessRun(runId),
    repo.getAgentTask(runId),
  ]);
  const chatExecution =
    !processRun &&
    !task &&
    typeof repo.findAgentRuntimeChatExecutionByTraceId === "function"
      ? await repo.findAgentRuntimeChatExecutionByTraceId(runId)
      : undefined;
  if (!processRun && !task && !chatExecution) return undefined;

  const traceId =
    processRun?.traceId ??
    task?.traceId ??
    chatExecution?.traceId ??
    chatExecution?.sessionTraceId ??
    runId;
  const parentAgentExecutionId = processRun
    ? agentExecutionIdFromProcessRun(processRun)
    : null;
  const originAgentExecutionId = processRun
    ? parentAgentExecutionIdFromProcessRun(processRun)
    : null;
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
    relatedTasks,
  ] = await Promise.all([
    processRun
      ? repo.getProcessRunSpans(processRun.runId)
      : Promise.resolve([]),
    processRun
      ? repo.getProcessRunEvents({ runId: processRun.runId, limit: 500 })
      : Promise.resolve([]),
    processRun
      ? repo.getProcessRunArtifacts(processRun.runId)
      : Promise.resolve([]),
    chatExecution &&
    typeof repo.getAgentRuntimeArtifactsForExecution === "function"
      ? repo.getAgentRuntimeArtifactsForExecution({
          executionId: chatExecution.executionId,
          sessionId: chatExecution.sessionId,
        })
      : Promise.resolve([]),
    task
      ? repo.getTaskProgressEventsForTask({ taskId: task.taskId, limit: 300 })
      : Promise.resolve([]),
    task
      ? repo.getSandboxCommandEventsForTask({ taskId: task.taskId, limit: 100 })
      : Promise.resolve([]),
    task ? repo.getSandboxRunsForTask(task.taskId) : Promise.resolve([]),
    traceId
      ? repo.getTraceEventsForTrace({ traceId, limit: 500 })
      : Promise.resolve([]),
    traceId
      ? repo.getAgentRuntimeEventsForTrace({ traceId, limit: 500 })
      : Promise.resolve([]),
    traceId
      ? repo.getAgentRuntimeMessagesForTrace({ traceId, limit: 150 })
      : Promise.resolve([]),
    traceId
      ? repo.getToolAuditLogsForTrace({ traceId, limit: 200 })
      : Promise.resolve([]),
    traceId
      ? repo.listProcessRunsForTrace({ traceId, limit: 20 })
      : Promise.resolve([]),
    originAgentExecutionId
      ? repo.findProcessRunByAgentExecutionId(originAgentExecutionId)
      : Promise.resolve(undefined),
    parentAgentExecutionId
      ? repo.listProcessRunsByParentAgentExecutionId({
          parentAgentExecutionId,
          limit: 20,
        })
      : Promise.resolve([]),
    traceId
      ? repo.listAgentTasksForTrace({ traceId, limit: 20 })
      : Promise.resolve([]),
  ]);

  const runtimeScope = runtimeSnapshotScope({
    traceId,
    runId,
    processRun,
    task,
    chatExecution,
  });
  const scopedRuntimeEvents = runtimeEvents.filter((event) =>
    runtimeEventMatchesScope(event, runtimeScope),
  );
  const scopedRuntimeMessages = runtimeMessages.filter((message) =>
    runtimeMessageMatchesScope(message, runtimeScope),
  );

  const spans = sortSpans([
    ...processSpans.map(spanFromProcess),
    ...scopedRuntimeEvents.flatMap(spanFromRuntimeEvent),
    ...taskEvents.flatMap(spansFromTaskEvent),
    ...sandboxRuns.map(spanFromSandboxRun),
    ...commands.map(spanFromCommand),
  ]);
  const run = processRun
    ? summaryFromProcessRun(processRun, spans)
    : task
      ? summaryFromTask(task, spans)
      : summaryFromAgentExecution(chatExecution!, spans);
  const events = sortEvents([
    ...processEvents.map(eventFromProcess),
    ...traceEvents.map(eventFromTrace),
    ...scopedRuntimeEvents.map(eventFromRuntime),
    ...taskEvents.map(eventFromTask),
    ...toolLogs.map(eventFromTool),
    ...commands.map(eventFromCommand),
  ]);
  const terminal = terminalFromCommands(commands);
  return {
    run,
    spans,
    events,
    artifacts: [
      ...processArtifacts,
      ...runtimeArtifacts.map(artifactFromRuntime),
    ],
    terminal,
    diagnostics: diagnosticsForRun(run, spans, events),
    raw: { processRun, task, sandboxRuns },
    agentTranscript: scopedRuntimeMessages.map(
      agentTranscriptMessageFromRuntime,
    ),
    relatedRuns: relatedRunSummaries({
      processRun,
      task,
      relatedProcessRuns: [
        ...relatedProcessRuns,
        ...(parentProcessRun ? [parentProcessRun] : []),
        ...childProcessRuns,
      ],
      relatedTasks,
    }),
    generatedAt: new Date(),
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
  addSetValue(
    messageIds,
    stringMetadata(input.chatExecution?.metadata.discordMessageId),
  );
  addSetValue(
    messageIds,
    stringMetadata(input.processRun?.metadata.currentMessageId),
  );
  addSetValue(
    messageIds,
    stringMetadata(input.processRun?.metadata.discordMessageId),
  );
  addSetValue(
    messageIds,
    stringMetadata(input.processRun?.metadata.discordResponseMessageId),
  );
  addSetValue(
    messageIds,
    stringMetadata(input.processRun?.metadata.replyMessageId),
  );

  for (const value of Object.values(input.processRun?.links ?? {})) {
    if (typeof value === "string")
      addSetValue(messageIds, extractDiscordMessageId(value));
  }

  addSetValue(taskIds, input.task?.taskId);
  addSetValue(
    taskIds,
    input.processRun?.runId?.startsWith("task-")
      ? input.processRun.runId
      : null,
  );
  addSetValue(taskIds, stringMetadata(input.processRun?.metadata.taskId));

  addSetValue(executionIds, agentExecutionIdFromProcessRun(input.processRun));
  addSetValue(
    executionIds,
    parentAgentExecutionIdFromProcessRun(input.processRun),
  );
  addSetValue(
    executionIds,
    stringMetadata(input.processRun?.metadata.executionId),
  );
  addSetValue(
    executionIds,
    stringMetadata(input.processRun?.metadata.agentRuntimeExecutionId),
  );
  addSetValue(executionIds, input.chatExecution?.executionId);
  addSetValue(executionIds, `agent-execution-${input.traceId}`);
  for (const taskId of taskIds)
    addSetValue(executionIds, `agent-task-execution-${taskId}`);

  return { traceId: input.traceId, messageIds, taskIds, executionIds };
}

function runtimeEventMatchesScope(
  event: AgentRuntimeEvent,
  scope: RuntimeSnapshotScope,
) {
  if (event.traceId === scope.traceId) return true;
  if (event.executionId && scope.executionIds.has(event.executionId))
    return true;
  if (metadataMatchesScope(event.metadata, scope)) return true;
  return false;
}

function runtimeMessageMatchesScope(
  message: AgentRuntimeMessage,
  scope: RuntimeSnapshotScope,
) {
  const clientMessageId = message.clientMessageId;
  if (clientMessageId && scope.messageIds.has(clientMessageId)) return true;
  if (clientMessageId?.startsWith(`${scope.traceId}:transcript:`)) return true;
  if (clientMessageId && scope.taskIds.has(clientMessageId)) return true;
  if (metadataMatchesScope(message.metadata, scope)) return true;
  return false;
}

function metadataMatchesScope(
  metadata: Record<string, unknown>,
  scope: RuntimeSnapshotScope,
) {
  const metadataMessageIds = [
    stringMetadata(metadata.traceId),
    stringMetadata(metadata.promptMessageId),
    stringMetadata(metadata.discordMessageId),
    stringMetadata(metadata.messageId),
    stringMetadata(metadata.runId),
    stringMetadata(metadata.replyMessageId),
  ];
  if (
    metadataMessageIds.some(
      (value) =>
        value === scope.traceId ||
        (value != null && scope.messageIds.has(value)),
    )
  )
    return true;

  const metadataTaskId = stringMetadata(metadata.taskId);
  if (metadataTaskId && scope.taskIds.has(metadataTaskId)) return true;

  const metadataExecutionIds = [
    stringMetadata(metadata.executionId),
    stringMetadata(metadata.agentExecutionId),
    stringMetadata(metadata.agentRuntimeExecutionId),
    stringMetadata(metadata.parentAgentExecutionId),
    stringMetadata(metadata.parentExecutionId),
  ];
  return metadataExecutionIds.some(
    (value) => value != null && scope.executionIds.has(value),
  );
}

function addSetValue(set: Set<string>, value: string | null | undefined) {
  if (value) set.add(value);
}

function agentTranscriptMessageFromRuntime(
  message: AgentRuntimeMessage,
): RunAgentTranscriptMessage {
  return {
    id: message.messageId,
    sessionId: message.sessionId,
    clientMessageId: message.clientMessageId,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata,
    createdAt: message.createdAt,
  };
}

function agentExecutionIdFromProcessRun(run: ProcessRunRecord | undefined) {
  if (!run) return null;
  const direct = stringMetadata(run.metadata.agentExecutionId);
  if (direct) return direct;
  return stringMetadata(run.metadata.agentRuntimeExecutionId);
}

function parentAgentExecutionIdFromProcessRun(
  run: ProcessRunRecord | undefined,
) {
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
  const currentIds = new Set(
    [input.processRun?.runId, input.task?.taskId].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const byId = new Map<string, RunSummary>();
  for (const run of input.relatedProcessRuns) {
    if (currentIds.has(run.runId)) continue;
    byId.set(run.runId, summaryFromProcessRun(run));
  }
  for (const task of input.relatedTasks) {
    if (currentIds.has(task.taskId) || byId.has(task.taskId)) continue;
    byId.set(task.taskId, summaryFromTask(task));
  }
  return [...byId.values()].sort(
    (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
  );
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
      content: `$ ${command.command ?? command.step}`,
    });
    if (command.outputTail.trim()) {
      entries.push({
        id: `command-${command.id}-stdout`,
        source: "command",
        stream: "stdout",
        step: command.step,
        command: command.command,
        createdAt: command.createdAt,
        content: command.outputTail.trimEnd(),
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
        content: command.errorTail.trimEnd(),
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
        content: `[exit ${command.exitCode} in ${formatDuration(command.durationMs)}]`,
      });
    }
  }
  const content = entries.map((entry) => entry.content).join("\n\n");
  return {
    content,
    lineCount: content ? content.split("\n").length : 0,
    entries,
  };
}

export function diagnosticsForRun(
  run: RunSummary,
  spans: RunSpan[],
  events: RunEvent[],
): string[] {
  const diagnostics: string[] = [];
  diagnostics.push(...codegenDiagnosticsForRun(run, events));
  const bottleneck = bottleneckSpan(spans);
  if (bottleneck)
    diagnostics.push(
      `Most time was spent in ${bottleneck.name}: ${formatDuration(bottleneck.durationMs)}.`,
    );
  const failureEvent = [...events]
    .reverse()
    .find((event) => event.level === "error");
  const failure =
    failureEvent?.summary ?? (run.status === "failed" ? run.summary : null);
  if (failure) diagnostics.push(`Latest failure signal: ${failure}`);
  if (!isTerminal(run.status))
    diagnostics.push(`Currently active at ${run.currentStep ?? "running"}.`);
  if (run.kind === "embedding" && typeof run.metadata.backlog === "number") {
    diagnostics.push(`Embedding backlog at run time: ${run.metadata.backlog}.`);
  }
  return diagnostics;
}

function codegenDiagnosticsForRun(run: RunSummary, events: RunEvent[]) {
  if (run.kind !== "codegen") return [];
  const diagnostics: string[] = [];
  const failureDiagnosis = codegenFailureDiagnosisFromMetadata(
    run.metadata.failureDiagnosis,
  );
  if (failureDiagnosis) {
    diagnostics.push(`Failure diagnosis: ${failureDiagnosis.summary}`);
    if (failureDiagnosis.nextAction)
      diagnostics.push(`Suggested next action: ${failureDiagnosis.nextAction}`);
  }
  const firstDiff = [...events].reverse().find((event) => {
    const step = eventMetadataStep(event);
    return (
      step === "codex_first_diff" ||
      step === "codex_app_server_first_diff" ||
      step === "opencode_first_diff" ||
      step === "opencode_first_edit"
    );
  });
  const noDiff = [...events]
    .reverse()
    .find(
      (event) =>
        eventMetadataStep(event).endsWith("_no_diff") ||
        run.status === "no_changes",
    );
  if (noDiff) {
    diagnostics.push("Coding agent finished without leaving a code diff.");
  } else if (!isTerminal(run.status) && !firstDiff) {
    diagnostics.push(
      "Coding agent is running; inspect the latest harness, tool, and command events for live progress.",
    );
  } else if (firstDiff) {
    const durationMs = numberFromUnknown(firstDiff.metadata.durationMs);
    diagnostics.push(
      `First visible edit appeared${durationMs == null ? "" : ` after ${formatDuration(durationMs)}`}.`,
    );
  }
  return diagnostics;
}

function codegenFailureDiagnosisFromMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary.trim()
      : null;
  if (!summary) return null;
  const nextAction =
    typeof record.nextAction === "string" && record.nextAction.trim()
      ? record.nextAction.trim()
      : null;
  return { summary, nextAction };
}

function eventMetadataStep(event: RunEvent) {
  const step = event.metadata.step;
  return typeof step === "string" ? step : event.name;
}

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sortSpans(spans: RunSpan[]) {
  return spans.sort(
    (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
  );
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

function formatDuration(value: number | null | undefined) {
  if (value == null) return "unknown";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
