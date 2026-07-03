import type { ProcessRunArtifactContent } from "../db/repositories.js";
import { formatOpenCodeTranscriptDiagnostics, parseOpenCodeTranscript } from "./openCodeTranscript.js";
import type { RunArtifactSummary, RunSnapshot, RunSpan, RunSummary, RunTerminalEntry } from "./runs.js";

export type RunInspectionOptions = {
  eventLimit?: number;
  includeDebug?: boolean;
  includeMetadata?: boolean;
  includeTerminal?: boolean;
  terminalLimit?: number;
};

export type RunSummaryListOptions = {
  kind?: string;
  status?: string;
  sort?: "updated" | "started" | "slowest";
  limit?: number;
};

export function formatRunSummaryList(runs: RunSummary[], options: RunSummaryListOptions = {}): string {
  const limit = clampInteger(options.limit ?? 20, 1, 500);
  const filtered = runs
    .filter((run) => !options.kind || run.kind === options.kind)
    .filter((run) => !options.status || run.status === options.status)
    .sort((left, right) => compareRunSummaries(left, right, options.sort ?? "updated"))
    .slice(0, limit);

  const lines = [
    `Runs (${filtered.length}${runs.length > filtered.length ? ` of ${runs.length}` : ""})`,
    `Sort: ${options.sort ?? "updated"}${options.kind ? ` | Kind: ${options.kind}` : ""}${options.status ? ` | Status: ${options.status}` : ""}`,
    ...runSummaryAggregateLines(filtered),
    ""
  ];
  if (filtered.length === 0) {
    lines.push("No matching runs.");
    return `${lines.join("\n")}\n`;
  }

  for (const run of filtered) {
    lines.push(`- ${run.runId} | ${run.kind} | ${run.status} | ${formatSeconds(run.durationMs)} | ${truncateSingleLine(run.title, 100)}`);
    const detail = [
      run.requester ? `requester=${run.requester}` : null,
      run.currentStep ? `step=${run.currentStep}` : null,
      run.bottleneck ? `bottleneck=${run.bottleneck.name} ${formatSeconds(run.bottleneck.durationMs)}` : null,
      run.links.pullRequest ? `pr=${String(run.links.pullRequest)}` : null,
      run.messageId ? `message=${run.messageId}` : null
    ]
      .filter(Boolean)
      .join(" | ");
    if (detail) lines.push(`  ${detail}`);
    const failureDiagnosis = codegenFailureDiagnosisFromMetadata(run.metadata.failureDiagnosis);
    if (failureDiagnosis) {
      lines.push(
        `  diagnosis=${failureDiagnosis.category ?? "unknown"} | ${truncateSingleLine(failureDiagnosis.summary, 180)} | next=${truncateSingleLine(failureDiagnosis.nextAction, 180)}`
      );
    }
    if (run.summary) lines.push(`  ${truncateSingleLine(run.summary, 220)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatRunInspection(snapshot: RunSnapshot, options: RunInspectionOptions = {}): string {
  const eventLimit = clampInteger(options.eventLimit ?? 80, 1, 500);
  const terminalLimit = clampInteger(options.terminalLimit ?? 40, 1, 500);
  const lines: string[] = [];
  const run = snapshot.run;

  lines.push(`${run.kind} run ${run.runId}`);
  lines.push(`${run.status}: ${run.title}`);
  if (run.summary) lines.push(wrapLine("Summary", run.summary));
  lines.push(
    [
      run.requester ? `Requester: ${run.requester}` : null,
      run.traceId ? `Trace: ${run.traceId}` : null,
      run.messageId ? `Message: ${run.messageId}` : null,
      `Duration: ${formatSeconds(run.durationMs)}`
    ]
      .filter(Boolean)
      .join(" | ")
  );
  if (run.bottleneck) lines.push(`Bottleneck: ${run.bottleneck.name} (${formatSeconds(run.bottleneck.durationMs)})`);
  if (Object.keys(run.links).length > 0) lines.push(wrapLine("Links", compactJson(run.links, 600)));

  if (snapshot.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diagnostic of snapshot.diagnostics) lines.push(`- ${diagnostic}`);
  }

  const modelUsage = formatModelUsage(snapshot);
  if (modelUsage.length > 0) {
    lines.push("");
    lines.push("Model usage:");
    lines.push(...modelUsage);
  }

  const slowestSpans = [...snapshot.spans]
    .filter((span) => span.durationMs != null)
    .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))
    .slice(0, 8);
  if (slowestSpans.length > 0) {
    lines.push("");
    lines.push("Slowest spans:");
    for (const span of slowestSpans) {
      lines.push(`- ${formatSeconds(span.durationMs)} ${span.name} (${span.source}, ${span.status})`);
      if (options.includeMetadata) appendMetadata(lines, span.metadata, "  ");
    }
  }

  const timeline = buildTimeline(snapshot, { includeDebug: options.includeDebug }).slice(0, eventLimit);
  if (timeline.length > 0) {
    lines.push("");
    lines.push(`Timeline (${timeline.length}${timeline.length === eventLimit ? "+" : ""} items):`);
    for (const item of timeline) {
      lines.push(`- ${formatDateTime(item.at)} ${item.kind} ${item.levelOrStatus} ${item.title}${item.durationMs == null ? "" : ` (${formatSeconds(item.durationMs)})`}`);
      if (item.summary) lines.push(`  ${truncateSingleLine(item.summary, 280)}`);
      if (options.includeMetadata && item.metadata) appendMetadata(lines, item.metadata, "  ");
    }
  }

  if (snapshot.artifacts.length > 0) {
    lines.push("");
    lines.push("Artifacts:");
    for (const artifact of snapshot.artifacts) {
      lines.push(
        `- ${artifact.artifactId} | ${artifact.kind} | ${artifact.name} | ${formatBytes(artifact.sizeBytes)}${artifact.redacted ? " | redacted" : ""}`
      );
      if (artifact.preview) lines.push(`  ${truncateSingleLine(artifact.preview, 220)}`);
    }
  }

  if (options.includeTerminal && snapshot.terminal.entries.length > 0) {
    lines.push("");
    lines.push(`Terminal tail (${Math.min(terminalLimit, snapshot.terminal.entries.length)} of ${snapshot.terminal.entries.length} entries):`);
    for (const entry of snapshot.terminal.entries.slice(-terminalLimit)) {
      lines.push(formatTerminalEntry(entry));
    }
  }

  lines.push("");
  lines.push(`Generated: ${formatDateTime(snapshot.generatedAt)}`);
  return `${lines.join("\n")}\n`;
}

function compareRunSummaries(left: RunSummary, right: RunSummary, sort: NonNullable<RunSummaryListOptions["sort"]>) {
  if (sort === "slowest") return (right.durationMs ?? -1) - (left.durationMs ?? -1);
  if (sort === "started") return right.startedAt.getTime() - left.startedAt.getTime();
  return right.updatedAt.getTime() - left.updatedAt.getTime();
}

function runSummaryAggregateLines(runs: RunSummary[]) {
  if (runs.length === 0) return [];
  const lines = [`Statuses: ${formatCounts(countBy(runs, (run) => run.status))}`];
  const kinds = countBy(runs, (run) => run.kind);
  if (kinds.size > 1) lines.push(`Kinds: ${formatCounts(kinds)}`);
  const diagnosisCategories = countBy(
    runs
      .map((run) => codegenFailureDiagnosisFromMetadata(run.metadata.failureDiagnosis)?.category)
      .filter((category): category is string => Boolean(category)),
    (category) => category
  );
  if (diagnosisCategories.size > 0) lines.push(`Codegen diagnoses: ${formatCounts(diagnosisCategories)}`);
  return lines;
}

function countBy<T>(items: T[], keyForItem: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyForItem(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}

function formatModelUsage(snapshot: RunSnapshot) {
  const usageSources = snapshot.spans.filter((span) => usageFromMetadata(span.metadata));
  const fallbackUsageSources =
    usageSources.length > 0
      ? []
      : snapshot.events.filter((event) => event.name === "agent.model.round.complete" && usageFromMetadata(event.metadata));
  const usageRows = [...usageSources, ...fallbackUsageSources].map((item) => ({
    model: stringFromUnknown(item.metadata.model) ?? "unknown",
    usage: usageFromMetadata(item.metadata)!
  }));
  const costRows = snapshot.events
    .filter((event) => event.source === "tool")
    .map((event) => ({
      model: stringFromUnknown(event.metadata.model) ?? "unknown",
      cost: numberFromUnknown(event.metadata.estimatedCostUsd)
    }))
    .filter((row): row is { model: string; cost: number } => row.cost != null);

  if (usageRows.length === 0 && costRows.length === 0) return [];

  const lines: string[] = [];
  if (usageRows.length > 0) {
    const totals = usageRows.reduce(
      (sum, row) => ({
        inputTokens: sum.inputTokens + (row.usage.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (row.usage.outputTokens ?? 0),
        totalTokens: sum.totalTokens + (row.usage.totalTokens ?? 0),
        reasoningTokens: sum.reasoningTokens + (row.usage.reasoningTokens ?? 0),
        cachedInputTokens: sum.cachedInputTokens + (row.usage.cachedInputTokens ?? 0)
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }
    );
    const modelList = [...new Set(usageRows.map((row) => row.model))].join(", ");
    const tokenParts = [
      totals.inputTokens > 0 ? `input=${totals.inputTokens}` : null,
      totals.outputTokens > 0 ? `output=${totals.outputTokens}` : null,
      totals.totalTokens > 0 ? `total=${totals.totalTokens}` : null,
      totals.reasoningTokens > 0 ? `reasoning=${totals.reasoningTokens}` : null,
      totals.cachedInputTokens > 0 ? `cached_input=${totals.cachedInputTokens}` : null
    ].filter(Boolean);
    lines.push(`- Token usage: ${tokenParts.join(" ") || "unknown"} across ${usageRows.length} LLM ${usageRows.length === 1 ? "call" : "calls"} (${modelList})`);
  }
  if (costRows.length > 0) {
    const total = costRows.reduce((sum, row) => sum + row.cost, 0);
    const byModel = new Map<string, number>();
    for (const row of costRows) byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.cost);
    lines.push(`- Estimated audited cost: ${formatUsd(total)} across ${costRows.length} model/tool ${costRows.length === 1 ? "audit" : "audits"}`);
    lines.push(`- Cost by model: ${[...byModel.entries()].map(([model, cost]) => `${model}=${formatUsd(cost)}`).join(", ")}`);
  }
  return lines;
}

function usageFromMetadata(metadata: Record<string, unknown>) {
  const usage = metadata.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const normalized = {
    inputTokens: numberFromUnknown(record.inputTokens),
    outputTokens: numberFromUnknown(record.outputTokens),
    totalTokens: numberFromUnknown(record.totalTokens),
    reasoningTokens: numberFromUnknown(record.reasoningTokens),
    cachedInputTokens: numberFromUnknown(record.cachedInputTokens)
  };
  return Object.values(normalized).some((value) => value != null) ? normalized : null;
}

function codegenFailureDiagnosisFromMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const summary = stringFromUnknown(record.summary);
  const nextAction = stringFromUnknown(record.nextAction);
  if (!summary || !nextAction) return null;
  return {
    category: stringFromUnknown(record.category),
    summary,
    nextAction
  };
}

export function formatRunArtifacts(artifacts: ProcessRunArtifactContent[]): string {
  if (artifacts.length === 0) return "No matching artifacts.\n";
  const lines: string[] = [];
  for (const artifact of artifacts) {
    lines.push(`--- ${artifact.name} (${artifact.artifactId}, ${artifact.kind}, ${formatBytes(artifact.sizeBytes)}) ---`);
    const openCodeDiagnostics = formatOpenCodeArtifactDiagnostics(artifact);
    if (openCodeDiagnostics) {
      lines.push(openCodeDiagnostics);
      lines.push("");
    }
    lines.push(artifact.content.trimEnd());
    lines.push("");
  }
  return lines.join("\n");
}

export function selectArtifacts(artifacts: RunArtifactSummary[], selector: string): RunArtifactSummary[] {
  const normalized = selector.trim().toLowerCase();
  if (!normalized || normalized === "all") return artifacts;
  return artifacts.filter((artifact) =>
    [artifact.artifactId, artifact.kind, artifact.name].some((value) => value.toLowerCase().includes(normalized))
  );
}

function buildTimeline(snapshot: RunSnapshot, options: { includeDebug?: boolean }) {
  const spanItems = snapshot.spans.map((span) => ({
    at: span.startedAt,
    kind: span.source,
    levelOrStatus: span.status,
    title: span.name,
    summary: spanSummary(span),
    durationMs: span.durationMs,
    metadata: span.metadata
  }));
  const eventItems = snapshot.events
    .filter((event) => options.includeDebug || event.level !== "debug")
    .map((event) => ({
      at: event.createdAt,
      kind: event.source,
      levelOrStatus: event.level,
      title: event.name,
      summary: event.summary,
      durationMs: event.durationMs,
      metadata: event.metadata
    }));
  const artifactItems = snapshot.artifacts.map((artifact) => ({
    at: artifact.createdAt,
    kind: "artifact",
    levelOrStatus: artifact.kind,
    title: artifact.name,
    summary: artifact.preview,
    durationMs: null,
    metadata: artifact.metadata
  }));
  return [...spanItems, ...eventItems, ...artifactItems].sort((left, right) => left.at.getTime() - right.at.getTime());
}

function spanSummary(span: RunSpan) {
  const command = stringFromUnknown(span.metadata.command);
  if (command) return command;
  const message = stringFromUnknown(span.metadata.message);
  if (message) return message;
  return null;
}

function appendMetadata(lines: string[], metadata: Record<string, unknown>, prefix: string) {
  if (Object.keys(metadata).length === 0) return;
  lines.push(`${prefix}metadata: ${compactJson(metadata, 1200)}`);
}

function formatTerminalEntry(entry: RunTerminalEntry) {
  const header = `${formatDateTime(entry.createdAt)} ${entry.stream} ${entry.step}${entry.command ? ` $ ${entry.command}` : ""}`;
  const content = entry.content.trim();
  if (!content) return `- ${header}`;
  return `- ${header}\n${indent(truncateMultiline(content, 2000), "  ")}`;
}

function wrapLine(label: string, value: string) {
  return `${label}: ${truncateSingleLine(value, 1000)}`;
}

export function formatSeconds(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs)) return "unknown";
  const sign = durationMs < 0 ? "-" : "";
  let ms = Math.abs(durationMs);
  if (ms < 60_000) return `${sign}${(ms / 1000).toFixed(3)}s`;
  const minutes = Math.floor(ms / 60_000);
  ms -= minutes * 60_000;
  const seconds = ms / 1000;
  if (Number.isInteger(seconds)) return `${sign}${minutes}m ${seconds}s`;
  return `${sign}${minutes}m ${seconds.toFixed(seconds < 10 ? 3 : 0)}s`;
}

function formatDateTime(date: Date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KiB";
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === units[units.length - 1]) break;
    value /= 1024;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function truncateSingleLine(value: string, maxChars: number) {
  return truncateMultiline(value.replace(/\s+/g, " ").trim(), maxChars);
}

function truncateMultiline(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()}... [truncated]`;
}

function compactJson(value: unknown, maxChars: number) {
  return truncateSingleLine(JSON.stringify(value), maxChars);
}

function indent(value: string, prefix: string) {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFromUnknown(value: unknown) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function formatUsd(value: number) {
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function formatOpenCodeArtifactDiagnostics(artifact: ProcessRunArtifactContent) {
  if (artifact.kind !== "command_log" || !/\bopencode\b/i.test(artifact.name)) return "";
  return formatOpenCodeTranscriptDiagnostics(parseOpenCodeTranscript(artifact.content), formatSeconds);
}
