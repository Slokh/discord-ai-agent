export type OpenCodeTranscriptItemKind = "round" | "tool" | "message" | "error" | "tokens";

export type OpenCodeToolSummary = {
  name: string;
  status: string | null;
  title: string;
  output: string;
  durationMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
};

export type ParsedOpenCodeTranscript = {
  isTranscript: boolean;
  launchCommand: string | null;
  rounds: number;
  toolCalls: number;
  textMessages: number;
  tokenTotal: number | null;
  totalDurationMs: number | null;
  modelWaitMs: number | null;
  toolDurationMs: number;
  interRoundGapMs: number;
  failedTools: number;
  repeatedReads: Array<{ title: string; count: number }>;
  firstToolAtMs: number | null;
  firstEditAtMs: number | null;
  firstEditRound: number | null;
  roundsBeforeFirstEdit: number | null;
  slowestRound: { round: number; durationMs: number; title: string } | null;
  activeRound: { round: number; durationMs: number; tools: string[]; lastEventAt: string } | null;
  items: Array<{
    id: string;
    kind: OpenCodeTranscriptItemKind;
    title: string;
    timestamp: string;
    body: string;
    command: string;
    output: string;
    durationMs: number | null;
    tools: OpenCodeToolSummary[];
    active?: boolean;
  }>;
};

type OpenCodeTranscriptRecord = {
  type: string;
  timestamp: number;
  part: Record<string, unknown>;
};

type OpenCodeStep = {
  start: number;
  end: number;
  tools: OpenCodeToolSummary[];
  texts: string[];
  finish: Record<string, unknown> | null;
};

export function parseOpenCodeTranscript(content: string): ParsedOpenCodeTranscript {
  const lines = content.split(/\r?\n/);
  const launchCommand = lines.find((line) => line.startsWith("$ "))?.slice(2).trim() || null;
  const records = lines.flatMap(parseOpenCodeTranscriptRecord);
  const steps: OpenCodeStep[] = [];
  let current: OpenCodeStep | null = null;
  let currentRound = 0;

  for (const record of records) {
    if (record.type === "step_start") {
      currentRound = steps.length + 1;
      current = { start: record.timestamp, end: record.timestamp, tools: [], texts: [], finish: null };
      continue;
    }
    if (!current) continue;
    current.end = Math.max(current.end, record.timestamp);
    if (record.type === "tool_use") {
      current.tools.push(openCodeToolSummary(record.part));
      continue;
    }
    if (record.type === "text") {
      const text = stringValue(objectValue(record.part)?.text);
      if (text) current.texts.push(text);
      continue;
    }
    if (record.type === "step_finish") {
      current.end = record.timestamp;
      current.finish = record.part;
      steps.push(current);
      current = null;
    }
  }

  const firstTimestamp = records[0]?.timestamp ?? null;
  const lastTimestamp = records.at(-1)?.timestamp ?? null;
  const activeRound =
    current && lastTimestamp != null
      ? {
          round: currentRound || steps.length + 1,
          durationMs: Math.max(0, lastTimestamp - current.start),
          tools: uniqueStrings(current.tools.map((tool) => tool.name).filter(Boolean)),
          lastEventAt: timestampToIso(lastTimestamp)
        }
      : null;
  const analysisSteps = current ? [...steps, current] : steps;
  const items = steps.map((step, index) => openCodeRoundItem(step, index + 1));
  if (current && activeRound) {
    items.push(openCodeActiveRoundItem(current, activeRound.round, lastTimestamp ?? current.start));
  }
  const toolCalls = analysisSteps.reduce((total, step) => total + step.tools.length, 0);
  const textMessages = items.filter((item) => item.kind === "message").length;
  const totalDurationMs = firstTimestamp == null || lastTimestamp == null ? null : Math.max(0, lastTimestamp - firstTimestamp);
  const toolDurationMs = analysisSteps.reduce((total, step) => total + step.tools.reduce((stepTotal, tool) => stepTotal + (tool.durationMs ?? 0), 0), 0);
  const roundDurationMs = analysisSteps.reduce((total, step) => total + Math.max(0, step.end - step.start), 0);
  const modelWaitMs = analysisSteps.length === 0 ? null : Math.max(0, roundDurationMs - toolDurationMs);
  const interRoundGapMs = analysisSteps.reduce((total, step, index) => {
    const next = analysisSteps[index + 1];
    return next ? total + Math.max(0, next.start - step.end) : total;
  }, 0);
  const failedTools = analysisSteps.reduce((total, step) => total + step.tools.filter((tool) => tool.status === "error" || tool.status === "failed").length, 0);
  const repeatedReads = repeatedOpenCodeReads(analysisSteps);
  const tokenTotal = lastNumber(steps.map((step) => numericMetadata(objectValue(step.finish?.tokens)?.total)));
  const firstToolAtMs = firstTimestamp == null ? null : firstToolOffsetMs(analysisSteps, firstTimestamp, () => true);
  const firstEdit = firstTimestamp == null ? null : firstToolMatch(analysisSteps, firstTimestamp, (tool) => tool.name === "edit");
  const firstEditAtMs = firstEdit?.offsetMs ?? null;
  const firstEditRound = firstEdit?.round ?? null;
  const roundsBeforeFirstEdit = firstEditRound == null ? null : Math.max(0, firstEditRound - 1);
  const slowestRound =
    items
      .filter((item): item is (typeof items)[number] & { durationMs: number } => item.durationMs != null)
      .map((item, index) => ({ round: index + 1, durationMs: item.durationMs, title: item.title }))
      .sort((left, right) => right.durationMs - left.durationMs)[0] ?? null;

  if (tokenTotal != null) {
    const timestamp = timestampToIso(records.at(-1)?.timestamp ?? firstTimestamp ?? 0);
    items.push({
      id: "opencode-token-usage",
      kind: "tokens",
      title: "Final token usage",
      timestamp,
      body: `Total: ${tokenTotal.toLocaleString()}`,
      command: "",
      output: "",
      durationMs: null,
      tools: []
    });
  }

  return {
    isTranscript: launchCommand != null && records.some((record) => record.type === "step_start" || record.type === "tool_use"),
    launchCommand,
    rounds: analysisSteps.length,
    toolCalls,
    textMessages,
    tokenTotal,
    totalDurationMs,
    modelWaitMs,
    toolDurationMs,
    interRoundGapMs,
    failedTools,
    repeatedReads,
    firstToolAtMs,
    firstEditAtMs,
    firstEditRound,
    roundsBeforeFirstEdit,
    slowestRound,
    activeRound,
    items
  };
}

export function formatOpenCodeTranscriptDiagnostics(transcript: ParsedOpenCodeTranscript, formatDuration = formatOpenCodeDuration) {
  if (!transcript.isTranscript) return "";
  const parts = [
    `total=${transcript.totalDurationMs == null ? "unknown" : formatDuration(transcript.totalDurationMs)}`,
    `model_wait=${transcript.modelWaitMs == null ? "unknown" : formatDuration(transcript.modelWaitMs)}`,
    `tool_time=${formatDuration(transcript.toolDurationMs)}`,
    transcript.interRoundGapMs > 0 ? `gaps=${formatDuration(transcript.interRoundGapMs)}` : null,
    transcript.firstEditAtMs == null ? "first_edit=none" : `first_edit=${formatDuration(transcript.firstEditAtMs)}`,
    transcript.roundsBeforeFirstEdit == null ? null : `rounds_before_first_edit=${transcript.roundsBeforeFirstEdit}`,
    `rounds=${transcript.rounds}`,
    `tool_calls=${transcript.toolCalls}`,
    transcript.failedTools > 0 ? `failed_tools=${transcript.failedTools}` : null
  ].filter(Boolean);
  const lines = [`OpenCode latency: ${parts.join(" | ")}`];
  if (transcript.slowestRound) {
    lines.push(`Slowest round: round ${transcript.slowestRound.round} ${formatDuration(transcript.slowestRound.durationMs)} (${transcript.slowestRound.title.replace(/^Round \d+:\s*/, "") || "no tools"})`);
  }
  if (transcript.activeRound) {
    lines.push(`Active round: round ${transcript.activeRound.round} running for ${formatDuration(transcript.activeRound.durationMs)} (${transcript.activeRound.tools.join(", ") || "no tools yet"})`);
  }
  if (transcript.repeatedReads.length > 0) {
    lines.push(`Repeated reads: ${transcript.repeatedReads.map((read) => `${read.title} x${read.count}`).join(", ")}`);
  }
  return lines.join("\n");
}

function parseOpenCodeTranscriptRecord(line: string): OpenCodeTranscriptRecord[] {
  const index = line.indexOf('{"type"');
  if (index < 0) return [];
  try {
    const parsed = JSON.parse(line.slice(index)) as Record<string, unknown>;
    const type = stringValue(parsed.type);
    const timestamp = numericMetadata(parsed.timestamp);
    if (!type || timestamp == null) return [];
    return [{ type, timestamp, part: objectValue(parsed.part) ?? {} }];
  } catch {
    return [];
  }
}

function openCodeRoundItem(step: OpenCodeStep, round: number): ParsedOpenCodeTranscript["items"][number] {
  const durationMs = Math.max(0, step.end - step.start);
  const toolNames = step.tools.map((tool) => tool.name).filter(Boolean);
  const toolDurationMs = step.tools.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
  const modelWaitMs = Math.max(0, durationMs - toolDurationMs);
  const finishReason = stringValue(step.finish?.reason);
  const tokens = objectValue(step.finish?.tokens);
  const reasoningTokens = numericMetadata(tokens?.reasoning);
  const totalTokens = numericMetadata(tokens?.total);
  const title = toolNames.length > 0 ? `Round ${round}: ${formatToolCallList(toolNames)}` : step.texts.length > 0 ? `Round ${round}: assistant message` : `Round ${round}`;
  const body = [
    finishReason ? `Finished: ${finishReason}` : "",
    durationMs > 0 ? `Model wait: ${formatOpenCodeDuration(modelWaitMs)}` : "",
    toolDurationMs > 0 ? `Tool time: ${formatOpenCodeDuration(toolDurationMs)}` : "",
    totalTokens != null ? `Tokens: ${totalTokens.toLocaleString()}` : "",
    reasoningTokens != null ? `Reasoning: ${reasoningTokens.toLocaleString()}` : "",
    step.texts.length > 0 ? step.texts.map((text) => truncateSingleLine(text, 280)).join("\n") : ""
  ]
    .filter(Boolean)
    .join(" · ");
  const timestamp = timestampToIso(step.start);
  return {
    id: `opencode-round-${round}-${step.start}`,
    kind: step.texts.length > 0 && toolNames.length === 0 ? "message" : step.tools.some((tool) => tool.status === "error" || tool.status === "failed") ? "error" : "round",
    title,
    timestamp,
    body,
    command: "",
    output: "",
    durationMs,
    tools: step.tools
  };
}

function openCodeActiveRoundItem(step: OpenCodeStep, round: number, lastTimestamp: number): ParsedOpenCodeTranscript["items"][number] {
  const durationMs = Math.max(0, lastTimestamp - step.start);
  const toolNames = step.tools.map((tool) => tool.name).filter(Boolean);
  const toolDurationMs = step.tools.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
  const modelWaitMs = Math.max(0, durationMs - toolDurationMs);
  const title = toolNames.length > 0 ? `Round ${round}: ${formatToolCallList(toolNames)}` : step.texts.length > 0 ? `Round ${round}: assistant message` : `Round ${round}`;
  const body = [
    "In progress",
    durationMs > 0 ? `Running for ${formatOpenCodeDuration(durationMs)}` : "",
    modelWaitMs > 0 ? `Model wait so far: ${formatOpenCodeDuration(modelWaitMs)}` : "",
    toolDurationMs > 0 ? `Tool time so far: ${formatOpenCodeDuration(toolDurationMs)}` : "",
    step.tools.some((tool) => tool.status === "error" || tool.status === "failed") ? "Some tools failed" : "",
    step.texts.length > 0 ? step.texts.map((text) => truncateSingleLine(text, 280)).join("\n") : ""
  ]
    .filter(Boolean)
    .join(" · ");
  const timestamp = timestampToIso(step.start);
  return {
    id: `opencode-round-${round}-${step.start}-active`,
    kind: "round",
    title,
    timestamp,
    body,
    command: "",
    output: "",
    durationMs,
    tools: step.tools,
    active: true
  };
}

function openCodeToolSummary(part: Record<string, unknown>): OpenCodeToolSummary {
  const state = objectValue(part.state);
  const input = objectValue(state?.input);
  const time = objectValue(state?.time);
  const name = stringValue(part.tool) ?? "tool";
  const status = stringValue(state?.status) ?? null;
  const title = stringValue(state?.title) ?? stringValue(input?.command) ?? stringValue(input?.filePath) ?? "";
  const output = openCodeToolOutput(name, stringValue(state?.output) ?? "");
  const startedAt = numericMetadata(time?.start);
  const endedAt = numericMetadata(time?.end);
  return {
    name,
    status,
    title,
    output,
    durationMs: startedAt != null && endedAt != null && endedAt >= startedAt ? endedAt - startedAt : null,
    startedAtMs: startedAt,
    endedAtMs: endedAt
  };
}

function openCodeToolOutput(toolName: string, output: string) {
  if (!output.trim()) return "";
  if (toolName === "read") return "";
  if (toolName === "edit" && /edit applied successfully/i.test(output)) return "Edit applied successfully.";
  return truncateSingleLine(output, 220);
}

function firstToolOffsetMs(steps: Array<{ start: number; tools: OpenCodeToolSummary[] }>, firstTimestamp: number, predicate: (tool: OpenCodeToolSummary) => boolean) {
  return firstToolMatch(steps, firstTimestamp, predicate)?.offsetMs ?? null;
}

function firstToolMatch(steps: Array<{ start: number; tools: OpenCodeToolSummary[] }>, firstTimestamp: number, predicate: (tool: OpenCodeToolSummary) => boolean) {
  for (const step of steps) {
    const tool = step.tools.find(predicate);
    if (tool) {
      return {
        round: steps.indexOf(step) + 1,
        offsetMs: Math.max(0, (tool.startedAtMs ?? step.start) - firstTimestamp)
      };
    }
  }
  return null;
}

function repeatedOpenCodeReads(steps: Array<{ tools: OpenCodeToolSummary[] }>) {
  const counts = new Map<string, number>();
  for (const step of steps) {
    for (const tool of step.tools) {
      if (tool.name !== "read") continue;
      const title = tool.title.trim();
      if (!title) continue;
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([title, count]) => ({ title, count }));
}

function formatToolCallList(tools: string[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(", ");
}

function lastNumber(values: Array<number | null>) {
  return [...values].reverse().find((value): value is number => value != null) ?? null;
}

function timestampToIso(timestamp: number) {
  return new Date(timestamp).toISOString();
}

function numericMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function truncateSingleLine(value: string, maxChars: number) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function formatOpenCodeDuration(value: number | null | undefined) {
  if (value == null) return "unknown";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
