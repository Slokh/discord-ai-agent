import type { ProcessRunArtifactContent } from "../db/repositories.js";
import { formatOpenCodeTranscriptDiagnostics, parseOpenCodeTranscript } from "./openCodeTranscript.js";
import type { RunArtifactSummary, RunSnapshot, RunSpan, RunTerminalEntry } from "./runs.js";

export type RunInspectionOptions = {
  eventLimit?: number;
  includeDebug?: boolean;
  includeMetadata?: boolean;
  includeTerminal?: boolean;
  terminalLimit?: number;
};

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

function formatOpenCodeArtifactDiagnostics(artifact: ProcessRunArtifactContent) {
  if (artifact.kind !== "command_log" || !/\bopencode\b/i.test(artifact.name)) return "";
  return formatOpenCodeTranscriptDiagnostics(parseOpenCodeTranscript(artifact.content), formatSeconds);
}
