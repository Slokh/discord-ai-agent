import type {
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
  source: "process" | "task" | "sandbox" | "command";
  name: string;
  status: ProcessRunStatus;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
};

export type RunEvent = {
  id: string;
  source: "process" | "trace" | "task" | "tool" | "command";
  level: "debug" | "info" | "warn" | "error";
  name: string;
  summary: string | null;
  createdAt: Date;
  durationMs: number | null;
  metadata: Record<string, unknown>;
};

export type RunArtifactSummary = ProcessRunArtifactRecord;

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
  generatedAt: Date;
};

export type RunResolution = {
  run: RunSummary;
  messageId: string;
};

export async function listRunSummaries(repo: DiscordAiAgentRepository, input: { limit?: number; includeEmbeddings?: boolean } = {}): Promise<RunSummary[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  const [processRuns, tasks] = await Promise.all([
    repo.listProcessRuns({ limit, includeEmbeddings: input.includeEmbeddings ?? true }),
    repo.listRecentAgentTasks(limit)
  ]);
  const byId = new Map<string, RunSummary>();
  for (const run of processRuns) byId.set(run.runId, summaryFromProcessRun(run));
  for (const task of tasks) {
    if (!byId.has(task.taskId)) byId.set(task.taskId, summaryFromTask(task));
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
  if (!processRun && !task) return undefined;

  const traceId = processRun?.traceId ?? task?.traceId ?? runId;
  const [processSpans, processEvents, artifacts, taskEvents, commands, sandboxRuns, traceEvents, toolLogs] = await Promise.all([
    processRun ? repo.getProcessRunSpans(processRun.runId) : Promise.resolve([]),
    processRun ? repo.getProcessRunEvents({ runId: processRun.runId, limit: 500 }) : Promise.resolve([]),
    processRun ? repo.getProcessRunArtifacts(processRun.runId) : Promise.resolve([]),
    task ? repo.getTaskEventsForTask({ taskId: task.taskId, limit: 300 }) : Promise.resolve([]),
    task ? repo.getSandboxCommandEventsForTask({ taskId: task.taskId, limit: 100 }) : Promise.resolve([]),
    task ? repo.getSandboxRunsForTask(task.taskId) : Promise.resolve([]),
    traceId ? repo.getTraceEventsForTrace({ traceId, limit: 500 }) : Promise.resolve([]),
    traceId ? repo.getToolAuditLogsForTrace({ traceId, limit: 200 }) : Promise.resolve([])
  ]);

  const spans = sortSpans([
    ...processSpans.map(spanFromProcess),
    ...taskEvents.flatMap(spansFromTaskEvent),
    ...sandboxRuns.map(spanFromSandboxRun),
    ...commands.map(spanFromCommand)
  ]);
  const run = processRun ? summaryFromProcessRun(processRun, spans) : summaryFromTask(task!, spans);
  const events = sortEvents([
    ...processEvents.map(eventFromProcess),
    ...traceEvents.map(eventFromTrace),
    ...taskEvents.map(eventFromTask),
    ...toolLogs.map(eventFromTool),
    ...commands.map(eventFromCommand)
  ]);
  const terminal = terminalFromCommands(commands);
  return {
    run,
    spans,
    events,
    artifacts,
    terminal,
    diagnostics: diagnosticsForRun(run, spans, events),
    raw: { processRun, task, sandboxRuns },
    generatedAt: new Date()
  };
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

function eventFromProcess(event: ProcessRunEventRecord): RunEvent {
  return {
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

function eventFromTask(event: TaskEvent): RunEvent {
  return {
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

function diagnosticsForRun(run: RunSummary, spans: RunSpan[], events: RunEvent[]): string[] {
  const diagnostics: string[] = [];
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
