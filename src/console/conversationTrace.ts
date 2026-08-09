type TraceRecord = Record<string, unknown>;

export type ConversationTraceTool = {
  id: string;
  title: string;
  status: string;
  occurredAt: unknown;
  durationMs: number | null;
  summary: string | null;
  sourceEventIds: string[];
};

export type ConversationTracePhase = {
  id: "context" | "prompt" | "intake" | "agent" | "response" | "delivery";
  title: string;
  status: string;
  startedAt: unknown;
  completedAt: unknown;
  durationMs: number | null;
  summary: string | null;
  message: TraceRecord | null;
  contextMessages: TraceRecord[];
  metadata: Record<string, unknown>;
  tools: ConversationTraceTool[];
  exceptions: Array<{
    id: string;
    title: string;
    summary: string | null;
    level: string;
    occurredAt: unknown;
    code: string;
  }>;
  sourceEventIds: string[];
};

export type ConversationTraceProjection = {
  startedAt: unknown;
  completedAt: unknown;
  totalDurationMs: number | null;
  intakeDurationMs: number | null;
  agentDurationMs: number | null;
  deliveryDurationMs: number | null;
  model: string | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  toolCount: number;
  contextCount: number;
  rawEventCount: number;
  phases: ConversationTracePhase[];
};

export function projectConversationTrace(input: {
  messages: TraceRecord[];
  traceEvents: TraceRecord[];
}): ConversationTraceProjection {
  const messages = [...input.messages].sort((left, right) => time(left.createdAt) - time(right.createdAt));
  const events = [...input.traceEvents].sort((left, right) => time(left.occurredAt) - time(right.occurredAt));
  const current = messages.find((message) => message.current === true) ?? messages.find((message) => message.role === "member") ?? null;
  const reply = [...messages].reverse().find((message) => message.reply === true) ?? null;
  const directParent = [...messages].reverse().find((message) => message.directParent === true) ?? null;
  const contextCount = messages.filter((message) => message !== current && message !== reply).length;
  const promptAt = current?.createdAt ?? events[0]?.occurredAt ?? null;
  const agentStart = firstEventTime(events, isAgentStart);
  const agentEnd = lastEventTime(events, isAgentEnd) ?? reply?.createdAt ?? null;
  const deliveryStart = firstEventTime(events, isDeliveryStart) ?? agentEnd;
  const terminalAt = lastEventTime(events, isTerminalExecutionEvent);
  const completedAt = latestTime(reply?.createdAt, terminalAt) ?? events.at(-1)?.occurredAt ?? null;
  const totalDurationMs = between(promptAt, completedAt);
  const intakeDurationMs = between(promptAt, agentStart);
  const agentDurationMs = between(agentStart, agentEnd);
  const deliveryDurationMs = between(deliveryStart, completedAt);
  const modelEvent = [...events].reverse().find((event) => String(event.code ?? "").includes("model.call.completed"))
    ?? [...events].reverse().find((event) => text(record(event.metadata)?.model) || text(record(event.metadata)?.requestedModel));
  const modelMetadata = record(modelEvent?.metadata);
  const usageMetadata = [...events].reverse().map((event) => record(event.metadata)).find((metadata) => record(metadata?.usage));
  const costMetadata = [...events].reverse().map((event) => record(event.metadata)).find((metadata) => finiteNumber(metadata?.estimatedCostUsd) != null);
  const usage = record(usageMetadata?.usage);
  const totalTokens = finiteNumber(usage?.total_tokens ?? usage?.totalTokens ?? usage?.total);
  const estimatedCostUsd = finiteNumber(costMetadata?.estimatedCostUsd);
  const tools = projectTools(events);
  const reportedToolCount = [...events].reverse()
    .map((event) => finiteNumber(record(event.metadata)?.toolCount))
    .find((value) => value != null);
  const toolCount = reportedToolCount ?? tools.length;
  const phases: ConversationTracePhase[] = [];

  if (directParent) {
    const olderContext = messages.filter((message) => message !== current && message !== reply && message !== directParent);
    phases.push(messagePhase("context", "Context", directParent, {
      contextCount,
      olderContextCount: olderContext.length,
    }, olderContext));
  }
  if (current) phases.push(messagePhase("prompt", current.author ? String(current.author) : "Prompt", current));

  const intakeEvents = events.filter((event) => eventBefore(event, agentStart));
  phases.push(eventPhase({
    id: "intake",
    title: "Intake",
    summary: "Queued and prepared for execution.",
    startedAt: promptAt,
    completedAt: agentStart,
    durationMs: intakeDurationMs,
    events: intakeEvents,
    metadata: {},
  }));

  const agentEvents = events.filter((event) => eventWithin(event, agentStart, agentEnd));
  phases.push(eventPhase({
    id: "agent",
    title: "Agent",
    summary: toolCount ? `Completed with ${toolCount} tool ${toolCount === 1 ? "call" : "calls"}.` : "Completed without tools.",
    startedAt: agentStart ?? promptAt,
    completedAt: agentEnd,
    durationMs: agentDurationMs,
    events: agentEvents,
    metadata: {
      model: text(modelMetadata?.model) ?? text(modelMetadata?.requestedModel),
      totalTokens,
      estimatedCostUsd,
      toolCount,
    },
    tools,
  }));

  if (reply) {
    const response = messagePhase("response", "Response", reply);
    response.startedAt = agentEnd ?? reply.createdAt;
    response.completedAt = response.startedAt;
    phases.push(response);
  }

  const deliveryEvents = deliveryStart == null
    ? events.filter((event) => String(event.code ?? "").startsWith("discord.delivery"))
    : events.filter((event) => eventAfter(event, deliveryStart));
  phases.push(eventPhase({
    id: "delivery",
    title: "Delivery",
    summary: reply ? "Delivered to Discord." : deliverySummary(deliveryEvents),
    startedAt: deliveryStart ?? agentEnd ?? promptAt,
    completedAt,
    durationMs: deliveryDurationMs,
    events: deliveryEvents,
    metadata: {},
    forceStatus: reply ? "done" : undefined,
  }));

  return {
    startedAt: promptAt,
    completedAt,
    totalDurationMs,
    intakeDurationMs,
    agentDurationMs,
    deliveryDurationMs,
    model: text(modelMetadata?.model) ?? text(modelMetadata?.requestedModel),
    totalTokens,
    estimatedCostUsd,
    toolCount,
    contextCount,
    rawEventCount: events.length,
    phases,
  };
}

function messagePhase(
  id: "context" | "prompt" | "response",
  title: string,
  message: TraceRecord,
  metadata: Record<string, unknown> = {},
  contextMessages: TraceRecord[] = [],
): ConversationTracePhase {
  return {
    id,
    title,
    status: message.deleted ? "blocked" : "done",
    startedAt: message.createdAt,
    completedAt: message.createdAt,
    durationMs: null,
    summary: text(message.content),
    message,
    contextMessages,
    metadata,
    tools: [],
    exceptions: [],
    sourceEventIds: [],
  };
}

function eventPhase(input: {
  id: "intake" | "agent" | "delivery";
  title: string;
  summary: string;
  startedAt: unknown;
  completedAt: unknown;
  durationMs: number | null;
  events: TraceRecord[];
  metadata: Record<string, unknown>;
  tools?: ConversationTraceTool[];
  forceStatus?: string;
}): ConversationTracePhase {
  const exceptions = input.events.filter(isException).map((event) => ({
    id: String(event.id),
    title: String(event.title ?? event.code ?? "Execution exception"),
    summary: text(event.summary),
    level: String(event.level ?? "warn"),
    occurredAt: event.occurredAt,
    code: String(event.code ?? ""),
  }));
  return {
    id: input.id,
    title: input.title,
    status: input.forceStatus ?? (exceptions.some((event) => event.level === "error") ? "failed" : exceptions.length ? "blocked" : input.completedAt ? "done" : "running"),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    summary: input.summary,
    message: null,
    contextMessages: [],
    metadata: compactRecord(input.metadata),
    tools: input.tools ?? [],
    exceptions,
    sourceEventIds: input.events.map((event) => String(event.id)),
  };
}

function projectTools(events: TraceRecord[]): ConversationTraceTool[] {
  const toolEvents = events.filter((event) => String(event.type) === "tool" || String(event.code ?? "").includes(".tool."));
  const terminal = toolEvents.filter((event) => /complete|completed|failed|error/.test(String(event.code ?? "")));
  const selected = terminal.length ? terminal : toolEvents;
  return selected.map((event, index) => {
    const metadata = record(event.metadata);
    return {
      id: `tool-${index}-${String(event.id)}`,
      title: text(metadata?.toolName) ?? String(event.title ?? "Tool call"),
      status: String(event.status ?? (event.level === "error" ? "failed" : "done")),
      occurredAt: event.occurredAt,
      durationMs: finiteNumber(event.durationMs),
      summary: text(event.summary),
      sourceEventIds: [String(event.id)],
    };
  });
}

function deliverySummary(events: TraceRecord[]) {
  if (events.some((event) => /failed|failure/.test(String(event.code ?? "")))) return "Discord delivery failed.";
  return "Discord delivery outcome was not recorded.";
}

function isAgentStart(event: TraceRecord) {
  return /(?:model\.call|model\.attempt|run)\.started$/.test(String(event.code ?? ""));
}

function isAgentEnd(event: TraceRecord) {
  return /(?:model\.call|run)\.completed$/.test(String(event.code ?? "")) || String(event.code ?? "").endsWith(".nanocodex.complete");
}

function isDeliveryStart(event: TraceRecord) {
  return String(event.code ?? "") === "discord.delivery.intent_stored";
}

function isTerminalExecutionEvent(event: TraceRecord) {
  return /agent\.execution\.(?:succeeded|failed|completed)$/.test(String(event.code ?? ""));
}

function isException(event: TraceRecord) {
  return ["warn", "error"].includes(String(event.level ?? "")) || /(failed|failure|blocked|stalled|retry)/i.test(String(event.code ?? ""));
}

function firstEventTime(events: TraceRecord[], predicate: (event: TraceRecord) => boolean) {
  return events.find(predicate)?.occurredAt ?? null;
}

function lastEventTime(events: TraceRecord[], predicate: (event: TraceRecord) => boolean) {
  return [...events].reverse().find(predicate)?.occurredAt ?? null;
}

function eventBefore(event: TraceRecord, boundary: unknown) {
  return boundary == null || time(event.occurredAt) < time(boundary);
}

function eventWithin(event: TraceRecord, start: unknown, end: unknown) {
  const value = time(event.occurredAt);
  return (start == null || value >= time(start)) && (end == null || value <= time(end));
}

function eventAfter(event: TraceRecord, boundary: unknown) {
  return boundary == null || time(event.occurredAt) >= time(boundary);
}

function latestTime(...values: unknown[]) {
  const selected = values.filter((value) => value != null && Number.isFinite(time(value)))
    .sort((left, right) => time(right) - time(left))[0];
  return selected ?? null;
}

function between(start: unknown, end: unknown) {
  if (start == null || end == null) return null;
  const duration = time(end) - time(start);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function time(value: unknown) {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

function compactRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate != null));
}

function record(value: unknown): TraceRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as TraceRecord : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
