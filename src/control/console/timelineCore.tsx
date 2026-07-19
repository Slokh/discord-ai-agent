import { formatOffset, metadataValue, titleCase } from "./consoleFormat.js";
import {
  Activity,
  Bot,
  FileText,
  MessageSquare,
  Wrench,
  XCircle,
} from "lucide-react";
import { type StatusFilter } from "./runInbox.js";
import {
  durationStartedAtForCompletedStep,
  groupTimelineSteps,
  phaseStatus,
  summedStepDuration,
  timelineStepOrder,
  withStepGaps,
  type FlowItemKind,
  type TimelineStep,
  type TimelineStepGroup,
  type TimelineStepKind,
} from "./timelineModel.js";
import {
  timelineTitleText,
  toolRequestArgumentsText,
  type TimelineToolRequest,
} from "./timelineText.js";
import type {
  AgentTranscriptMessage,
  EventLevel,
  RunArtifact,
  RunCount,
  RunEvent,
  RunListAggregate,
  RunSnapshot,
  RunSpan,
  RunStatus,
  RunSummary,
} from "./types.js";

type TimedRunEvent = { event: RunEvent; gapMs: number | null; offset: string };
export type TimelineTrace = {
  steps: TimelineStep[];
  groups: TimelineStepGroup[];
  durationMs: number;
  status: RunStatus;
  slowest: { name: string; durationMs: number } | null;
};
export type FlowItem = {
  id: string;
  kind: FlowItemKind;
  title: string;
  summary: string;
  createdAt: string;
  durationMs: number | null;
  source: string;
  level: EventLevel | null;
  metadata: Record<string, unknown>;
  artifact?: RunArtifact;
};
export function numericMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringMetadata(value: unknown) {
  return typeof value === "string" ? value : null;
}

export function numberMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function objectMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function summarizeRuns(
  runs: RunSummary[],
  includeEmbeddings: boolean,
  aggregate: RunListAggregate | null,
) {
  const visible = includeEmbeddings
    ? runs
    : runs.filter((run) => run.kind !== "embedding");
  const visibleAggregate = aggregate ?? aggregateConsoleRuns(visible);
  return {
    active: visibleAggregate.active,
    attention: visibleAggregate.attention,
    codegen: countFromAggregate(visibleAggregate.byKind, "codegen"),
    hiddenEmbeddings: includeEmbeddings
      ? 0
      : runs.filter((run) => run.kind === "embedding").length,
  };
}

export function aggregateConsoleRuns(runs: RunSummary[]): RunListAggregate {
  return {
    total: runs.length,
    active: runs.filter((run) => !isTerminal(run.status)).length,
    attention: runs.filter(
      (run) =>
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "no_changes",
    ).length,
    terminal: runs.filter((run) => isTerminal(run.status)).length,
    byStatus: countRunsBy(runs, (run) => run.status),
    byKind: countRunsBy(runs, (run) => run.kind),
    codegenDiagnoses: countRunsBy(
      runs
        .map((run) => codegenDiagnosisCategory(run.metadata.failureDiagnosis))
        .filter((category): category is string => Boolean(category)),
      (category) => category,
    ),
  };
}

export function countRunsBy<T>(
  items: T[],
  keyForItem: (item: T) => string,
): RunCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyForItem(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([name, count]) => ({ name, count }));
}

export function countFromAggregate(counts: RunCount[], name: string) {
  return counts.find((item) => item.name === name)?.count ?? 0;
}

export function codegenDiagnosisCategory(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const category = (value as Record<string, unknown>).category;
  return typeof category === "string" && category.trim()
    ? category.trim()
    : null;
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function isExactRunStatusFilter(
  value: StatusFilter,
): value is RunStatus {
  return isRunStatus(value);
}

export function isRunStatus(value: string): value is RunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "no_changes" ||
    value === "cancelled"
  );
}

export function isTerminal(status: RunStatus) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "no_changes" ||
    status === "cancelled"
  );
}

export function timelineTrace({
  events,
  spans,
  flows,
  startedAt,
}: {
  events: TimedRunEvent[];
  spans: RunSpan[];
  flows: FlowItem[];
  startedAt: string;
}): TimelineTrace {
  const steps: TimelineStep[] = [];
  const flowEventIds = new Set(
    flows.map((flow) => flow.id.match(/^event-(.+)$/)?.[1]).filter(Boolean),
  );
  for (const span of spans) {
    if (isEnvelopeSpan(span)) continue;
    steps.push(timelineStepFromSpan(span, startedAt));
  }
  for (const flow of flows) {
    steps.push(timelineStepFromFlow(flow, startedAt));
  }
  for (const event of events) {
    if (flowEventIds.has(event.event.id)) continue;
    if (isLowSignalTimelineEvent(event.event)) continue;
    if (isDuplicateSpanEvent(event.event, spans)) continue;
    steps.push(timelineStepFromEvent(event));
  }
  return buildTimelineTrace(steps);
}

export function relatedRunTimelineSteps(
  runs: RunSummary[],
  input: { startedAt: string; generatedAt: string },
): TimelineStep[] {
  return runs.map((run) => {
    const durationMs = relatedRunDurationMs(run, input.generatedAt);
    return {
      id: `related-run-${run.runId}`,
      kind: "run",
      title: relatedRunTitle(run),
      summary: relatedRunSummary(run),
      createdAt: run.startedAt,
      durationMs,
      durationStartedAt: run.startedAt,
      gapMs: null,
      offset: formatOffset(input.startedAt, run.startedAt),
      source: "related run",
      status: run.status,
      level:
        run.status === "failed" || run.status === "cancelled" ? "error" : null,
      metadata: {
        runId: run.runId,
        traceId: run.traceId,
        kind: run.kind,
        currentStep: run.currentStep,
        links: run.links,
      },
    };
  });
}

export function relatedRunTitle(run: RunSummary) {
  const kind =
    run.kind === "codegen" ? "Codegen task" : `${titleCase(run.kind)} run`;
  if (run.status === "running") return `${kind} running`;
  if (run.status === "queued") return `${kind} queued`;
  if (run.status === "succeeded") return `${kind} completed`;
  if (run.status === "no_changes") return `${kind} finished with no changes`;
  if (run.status === "cancelled") return `${kind} cancelled`;
  return `${kind} failed`;
}

export function relatedRunSummary(
  run: RunSummary,
  options: { includeTitle?: boolean } = {},
) {
  const includeTitle = options.includeTitle ?? true;
  return [
    includeTitle ? run.title : null,
    run.currentStep ? `Current step: ${run.currentStep}.` : null,
    run.summary,
    typeof run.links.pullRequest === "string"
      ? `PR: ${run.links.pullRequest}`
      : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ");
}

export function relatedRunDurationMs(run: RunSummary, generatedAt: string) {
  if (typeof run.durationMs === "number" && Number.isFinite(run.durationMs))
    return run.durationMs;
  if (isTerminal(run.status)) return null;
  const startedAt = new Date(run.startedAt).getTime();
  const endedAt = new Date(generatedAt).getTime();
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    endedAt < startedAt
  )
    return null;
  return endedAt - startedAt;
}

export function sortTimelineSteps(steps: TimelineStep[]) {
  return [...steps]
    .sort((left, right) => {
      const timeDelta =
        new Date(left.createdAt).getTime() -
        new Date(right.createdAt).getTime();
      if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
      return timelineStepOrder(left.kind) - timelineStepOrder(right.kind);
    })
    .map((step, index, sortedSteps) => {
      const previous = index > 0 ? sortedSteps[index - 1] : null;
      const gapMs = previous
        ? new Date(step.createdAt).getTime() -
          new Date(previous.createdAt).getTime()
        : null;
      return {
        ...step,
        gapMs:
          gapMs != null && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null,
      };
    });
}

export function timelineStart(
  defaultStartedAt: string,
  events: RunEvent[],
  spans: RunSpan[],
  flows: FlowItem[],
) {
  const times = [
    defaultStartedAt,
    ...events.map((event) => event.createdAt),
    ...spans.map((span) => span.startedAt),
    ...flows.map((flow) => flow.createdAt),
  ]
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (times.length === 0) return defaultStartedAt;
  return new Date(Math.min(...times)).toISOString();
}

export function buildTimelineTrace(steps: TimelineStep[]): TimelineTrace {
  const sortedSteps = withStepGaps(steps);
  const groups = groupTimelineSteps(sortedSteps);
  const countedSteps = groups.map((group) => group.parent);
  const durations = countedSteps
    .map((step) => ({
      name: timelineTitleText(step),
      durationMs: step.durationMs ?? 0,
    }))
    .filter((item) => item.durationMs > 0);
  const durationMs = summedStepDuration(countedSteps);
  const slowest =
    durations.length > 0
      ? durations.reduce(
          (current, item) =>
            item.durationMs > current.durationMs ? item : current,
          durations[0]!,
        )
      : null;
  return {
    steps: sortedSteps,
    groups,
    durationMs,
    status: phaseStatus(sortedSteps),
    slowest,
  };
}

export function timelineStepFromSpan(
  span: RunSpan,
  startedAt: string,
): TimelineStep {
  return {
    id: `span-${span.id}`,
    kind: "span",
    title: span.name,
    summary: spanSummary(span),
    createdAt: span.startedAt,
    durationMs: span.durationMs,
    durationStartedAt: span.startedAt,
    gapMs: null,
    offset: formatOffset(startedAt, span.startedAt),
    source: span.source,
    status: span.status,
    level: null,
    metadata: span.metadata,
  };
}

export function timelineStepFromFlow(
  flow: FlowItem,
  startedAt: string,
): TimelineStep {
  return {
    id: flow.id,
    kind: flow.kind,
    title: flow.title,
    summary: flow.summary,
    createdAt: flow.createdAt,
    durationMs: flow.durationMs,
    durationStartedAt: durationStartedAtForCompletedStep(
      flow.createdAt,
      flow.durationMs,
    ),
    gapMs: null,
    offset: formatOffset(startedAt, flow.createdAt),
    source: flow.source,
    status: null,
    level: flow.level,
    metadata: flow.metadata,
    artifact: flow.artifact,
  };
}

export function timelineStepFromEvent({
  event,
  offset,
}: TimedRunEvent): TimelineStep {
  return {
    id: `event-${event.id}`,
    kind: event.level === "error" ? "error" : "event",
    title: timelineEventTitle(event.name),
    summary: event.summary ?? "No summary recorded.",
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    durationStartedAt: durationStartedAtForCompletedStep(
      event.createdAt,
      event.durationMs,
    ),
    gapMs: null,
    offset,
    source: event.source,
    status: null,
    level: event.level,
    metadata: event.metadata,
  };
}

export function timelineEventTitle(name: string) {
  const text = normalizedTimelineName(name);
  if (/\bdiscord mention received\b/.test(text)) return "User prompt";
  if (/\bdiscord thinking sent\b/.test(text)) return "Thinking reply sent";
  return humanizeEventName(name);
}

export function spanSummary(span: RunSpan) {
  const explicitSummary =
    typeof span.metadata.summary === "string" ? span.metadata.summary : null;
  if (explicitSummary) return explicitSummary;
  if (span.status === "running") return "Still running.";
  return "";
}

export function isEnvelopeSpan(span: RunSpan) {
  return /\b(kubernetes sandbox|sandbox command|run total|task total|sandbox lifetime)\b/i.test(
    span.name.replace(/[._-]+/g, " "),
  );
}

export function isLowSignalTimelineEvent(event: RunEvent) {
  if (event.level === "warn" || event.level === "error") return false;
  const text = `${event.name} ${event.summary ?? ""}`
    .toLowerCase()
    .replace(/[._-]+/g, " ");
  return /\b(task progress|progress update|heartbeat|stream chunk|log chunk)\b/.test(
    text,
  );
}

export function isDuplicateSpanEvent(event: RunEvent, spans: RunSpan[]) {
  const eventName = normalizedTimelineName(event.name);
  const eventDuration = event.durationMs ?? 0;
  if (!eventName || eventDuration <= 0) return false;
  return spans.some((span) => {
    if (
      normalizedTimelineName(span.name) !== eventName &&
      !(eventName === "sandbox command" && span.source === "command")
    )
      return false;
    const spanDuration = span.durationMs ?? 0;
    if (spanDuration <= 0) return false;
    return Math.abs(spanDuration - eventDuration) < 750;
  });
}

export function normalizedTimelineName(value: string) {
  return value
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function conversationFlow(snapshot: RunSnapshot): FlowItem[] {
  const transcriptItems = agentTranscriptFlowItems(snapshot);
  const eventItems = snapshot.events
    .filter(isFlowEvent)
    .map((event): FlowItem => {
      const callType = callKind(event);
      return {
        id: `event-${event.id}`,
        kind: event.level === "error" ? "error" : eventKind(event, callType),
        title: timelineEventTitle(event.name),
        summary: event.summary ?? "No summary",
        createdAt: event.createdAt,
        durationMs: event.durationMs,
        source: event.source,
        level: event.level,
        metadata: event.metadata,
      };
    });
  const artifactItems = snapshot.artifacts
    .filter(isFlowArtifact)
    .map((artifact): FlowItem => ({
      id: `artifact-${artifact.artifactId}`,
      kind: artifactKind(artifact),
      title: artifact.name,
      summary: artifact.preview || `${artifact.kind} artifact`,
      createdAt: artifact.createdAt,
      durationMs: null,
      source: "artifact",
      level: null,
      metadata: artifact.metadata,
      artifact,
    }));
  return [...eventItems, ...artifactItems, ...transcriptItems].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
}

export function agentTranscriptFlowItems(
  snapshot: Pick<RunSnapshot, "agentTranscript">,
): FlowItem[] {
  return (snapshot.agentTranscript ?? []).map((message): FlowItem => {
    const toolRequests = agentTranscriptToolRequestsFromMessage(message);
    return {
      id: `agent-transcript-${message.id}`,
      kind: agentTranscriptKind(message),
      title: agentTranscriptTitle(message),
      summary: agentTranscriptSummary(message),
      createdAt: message.createdAt,
      durationMs: numberMetadata(message.metadata.durationMs),
      source: "agent session",
      level: null,
      metadata: {
        ...message.metadata,
        agentTranscript: true,
        agentTranscriptMessageId: message.id,
        role: message.role,
        clientMessageId: message.clientMessageId,
        ...(toolRequests.length > 0
          ? { timelineToolRequests: toolRequests }
          : {}),
      },
    };
  });
}

export function agentTranscriptKind(
  message: AgentTranscriptMessage,
): FlowItemKind {
  if (message.role === "tool") return "tool";
  if (message.role === "assistant")
    return agentTranscriptToolRequestsFromMessage(message).length > 0
      ? "model"
      : "response";
  if (message.role === "user") return "input";
  return "artifact";
}

export function agentTranscriptTitle(message: AgentTranscriptMessage) {
  if (message.role === "user") return "User prompt";
  if (
    message.role === "assistant" &&
    agentTranscriptToolRequestsFromMessage(message).length > 0
  )
    return "Assistant requested tools";
  if (message.role === "assistant") return "Assistant reply";
  if (message.role === "tool") {
    const toolName = agentTranscriptToolName(message);
    return toolName ? `Tool result: ${toolName}` : "Tool result";
  }
  return "Session message";
}

export function agentTranscriptSummary(message: AgentTranscriptMessage) {
  const summaries = message.parts
    .map(agentTranscriptPartSummary)
    .filter(Boolean);
  return summaries.join(" | ") || metadataValue(message.parts);
}

export function agentTranscriptPartSummary(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object" || Array.isArray(part))
    return String(part ?? "");
  const record = part as Record<string, unknown>;
  const type = stringMetadata(record.type);
  if (type === "text") return stringMetadata(record.text) ?? "";
  if (type === "assistant_tool_calls") {
    const requests = agentTranscriptToolRequestsFromPart(record);
    return requests.length > 0
      ? `Requested tools: ${requests.map((request) => request.name).join(", ")}`
      : "Requested tools";
  }
  if (type === "tool_result") {
    const toolName = stringMetadata(record.toolName) ?? "tool";
    const taskId = stringMetadata(record.taskId);
    const status = stringMetadata(record.status);
    const content = stringMetadata(record.content);
    if (taskId) return `${toolName} ${taskId}${status ? ` ${status}` : ""}`;
    return `${toolName}: ${content ?? ""}`.trim();
  }
  return metadataValue(record);
}

export function agentTranscriptToolName(message: AgentTranscriptMessage) {
  for (const part of message.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const toolName = stringMetadata((part as Record<string, unknown>).toolName);
    if (toolName) return toolName;
  }
  return stringMetadata(message.metadata.toolName);
}

export function agentTranscriptToolRequestsFromMessage(
  message: AgentTranscriptMessage,
): TimelineToolRequest[] {
  return message.parts.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    return agentTranscriptToolRequestsFromPart(part as Record<string, unknown>);
  });
}

export function agentTranscriptToolRequestsFromPart(
  part: Record<string, unknown>,
): TimelineToolRequest[] {
  const calls = Array.isArray(part.toolCalls) ? part.toolCalls : [];
  return calls.flatMap((call): TimelineToolRequest[] => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const name = stringMetadata(record.name);
    if (!name) return [];
    const id = stringMetadata(record.id);
    return [
      {
        ...(id ? { id } : {}),
        name,
        argumentsText: toolRequestArgumentsText(record),
      },
    ];
  });
}

export function agentTranscriptToolRequests(
  step: TimelineStep,
): TimelineToolRequest[] {
  if (!step.metadata.agentTranscript) return [];
  const requests = step.metadata.timelineToolRequests;
  if (!Array.isArray(requests)) return [];
  return requests.flatMap((request): TimelineToolRequest[] => {
    if (!request || typeof request !== "object") return [];
    const record = request as Record<string, unknown>;
    const name = stringMetadata(record.name);
    if (!name) return [];
    const id = stringMetadata(record.id);
    return [
      {
        ...(id ? { id } : {}),
        name,
        argumentsText: stringMetadata(record.argumentsText),
      },
    ];
  });
}

export function isFlowEvent(event: RunEvent) {
  if (event.level === "error") return true;
  if (isLowSignalTimelineEvent(event)) return false;
  if (event.category)
    return ["ingress", "model", "tool", "retrieval", "delivery"].includes(
      event.category,
    );
  const kind = callKind(event);
  if (kind === "model" || kind === "tool") return true;
  return /\b(prompt|input|mention|message|reply|respond|response|completed|failed|final answer)\b/i.test(
    `${event.name} ${event.summary ?? ""}`,
  );
}

export function isFlowArtifact(artifact: RunArtifact) {
  return /\b(prompt|response|transcript|conversation|model|tool|message|error|request|reply)\b/i.test(
    `${artifact.kind} ${artifact.name}`,
  );
}

export function eventKind(
  event: RunEvent,
  callType: ReturnType<typeof callKind>,
): FlowItemKind {
  if (callType === "model") return "model";
  if (callType === "tool") return "tool";
  if (event.category === "delivery") return "response";
  if (
    event.category === "ingress" ||
    event.category === "context" ||
    event.category === "retrieval"
  )
    return "input";
  if (
    /\b(reply|respond|response|completed|final answer)\b/i.test(
      `${event.name} ${event.summary ?? ""}`,
    )
  )
    return "response";
  return "input";
}

export function artifactKind(artifact: RunArtifact): FlowItemKind {
  const text = `${artifact.kind} ${artifact.name}`.toLowerCase();
  if (/error|response|reply/.test(text)) return "response";
  if (/model|transcript|conversation/.test(text)) return "model";
  if (/tool/.test(text)) return "tool";
  return "artifact";
}

export function timelineStepIcon(kind: TimelineStepKind) {
  if (kind === "run") return <Bot />;
  if (kind === "span" || kind === "event") return <Activity />;
  if (kind === "model" || kind === "input" || kind === "response")
    return <MessageSquare />;
  if (kind === "tool") return <Wrench />;
  if (kind === "error") return <XCircle />;
  return <FileText />;
}

export function timelineStepLabel(kind: TimelineStepKind) {
  if (kind === "span") return "span";
  if (kind === "event") return "event";
  return kind;
}

export function callKind(event: RunEvent) {
  if (event.category === "model") return "model";
  if (event.category === "tool" || event.category === "retrieval")
    return "tool";
  if (event.category) return "process";
  if (
    event.source === "tool" ||
    /tool|discordhistory|discordstats|generateimage|inspect|fetch|search/i.test(
      event.name,
    )
  )
    return "tool";
  if (/model|openrouter|chat|embed|image|completion/i.test(event.name))
    return "model";
  return "process";
}

export function humanizeEventName(value: string) {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}
