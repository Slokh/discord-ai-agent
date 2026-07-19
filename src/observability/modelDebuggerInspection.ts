import type { RunSnapshot } from "./runTypes.js";
import { redactSensitiveText } from "./redaction.js";
import { truncateForDiscord } from "../util/text.js";

type ModelCallFact = {
  id: string;
  purpose: string;
  model: string;
  durationMs: number;
  promptBytes: number;
  toolSchemaBytes: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  requestedTools: string[];
  serverToolUse: Record<string, number>;
  urlCitationCount: number;
  sections: Array<{ name: string; bytes: number; estimatedTokens: number }>;
};

export function formatModelDebuggerInspection(snapshot: RunSnapshot): string {
  const calls = modelCallFacts(snapshot);
  if (calls.length === 0) return "Model debugger: no observed model-call telemetry was recorded for this run.";
  const wallMs = snapshot.run.durationMs ?? 0;
  const modelMs = calls.reduce((sum, call) => sum + call.durationMs, 0);
  const toolMs = snapshot.agentTranscript.reduce((sum, message) => {
    if (message.role !== "tool") return sum;
    return sum + positiveNumber(message.metadata.durationMs);
  }, 0);
  const uninstrumentedMs = Math.max(0, wallMs - modelMs - toolMs);
  const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const cachedTokens = calls.reduce((sum, call) => sum + call.cachedInputTokens, 0);
  const costUsd = calls.reduce((sum, call) => sum + call.costUsd, 0);
  const cacheRate = inputTokens > 0 ? Math.round(cachedTokens / inputTokens * 100) : null;
  const lines = [
    "Model debugger (observed execution; no private chain-of-thought):",
    `- Critical path: wall=${formatDuration(wallMs)} model=${formatDuration(modelMs)} tool=${formatDuration(toolMs)} uninstrumented=${formatDuration(uninstrumentedMs)}${cacheRate == null ? "" : ` cache=${cacheRate}%`}${costUsd > 0 ? ` cost=$${costUsd.toFixed(6)}` : ""}`,
    `- Diagnosis: ${criticalPathDiagnosis({ wallMs, modelMs, toolMs, uninstrumentedMs, calls: calls.length })}`,
  ];
  for (const [index, call] of calls.slice(0, 6).entries()) {
    lines.push(
      `- Call ${index + 1} ${humanize(call.purpose)}: ${call.model} | ${formatDuration(call.durationMs)} | ${formatNumber(call.inputTokens)} in/${formatNumber(call.outputTokens)} out/${formatNumber(call.cachedInputTokens)} cached${call.costUsd > 0 ? ` | cost=$${call.costUsd.toFixed(6)}` : ""} | prompt=${formatBytes(call.promptBytes)} schemas=${formatBytes(call.toolSchemaBytes)}${call.requestedTools.length > 0 ? ` | requested=${call.requestedTools.join(",")}` : ""}${Object.keys(call.serverToolUse).length > 0 ? ` | server=${formatServerToolUse(call.serverToolUse)}` : ""}${call.urlCitationCount > 0 ? ` | citations=${call.urlCitationCount}` : ""}`,
    );
    if (call.sections.length > 0) {
      lines.push(`  Prompt sections: ${call.sections.slice(0, 8).map((section) => `${humanize(section.name)}=${formatNumber(section.estimatedTokens)}t/${formatBytes(section.bytes)}`).join("; ")}`);
    }
  }
  const promptCaptures = snapshot.artifacts.filter((artifact) => String(artifact.kind) === "model_prompt").length;
  const responseCaptures = snapshot.artifacts.filter((artifact) => String(artifact.kind) === "model_response").length;
  lines.push(`- Redacted captures: prompts=${promptCaptures} responses=${responseCaptures}. Use detail=model_io to inspect bounded contents.`);
  return lines.join("\n");
}

export function formatModelIoCaptures(captures: Array<{ kind: string; name: string; content: string | null }>) {
  if (captures.length === 0) return "Observed model I/O: this run has no prompt/response captures (it may predate capture support).";
  const lines = ["Observed model I/O (authenticated, secret-redacted, bounded excerpts):"];
  for (const capture of captures) {
    lines.push(`## ${capture.kind === "model_prompt" ? "Model input" : "Model output"} · ${capture.name}`);
    lines.push(capture.content == null ? "Capture expired or unavailable." : truncateForDiscord(redactSensitiveText(capture.content).text, 900));
  }
  return lines.join("\n");
}

function modelCallFacts(snapshot: RunSnapshot): ModelCallFact[] {
  const observed = snapshot.events.filter((event) => event.name === "agent.model.call.completed" || event.name === "agent.model.call.failed");
  const events = observed.length > 0 ? observed : snapshot.events.filter((event) => event.name === "agent.model.round.complete");
  return events.map((event) => {
    const metadata = event.metadata;
    const usage = record(metadata.usage);
    return {
      id: stringValue(metadata.callId) ?? event.id,
      purpose: stringValue(metadata.purpose) ?? (metadata.round ? `tool_selection_round_${metadata.round}` : "model_call"),
      model: stringValue(metadata.model) ?? stringValue(metadata.requestedModel) ?? "unknown",
      durationMs: event.durationMs ?? 0,
      promptBytes: positiveNumber(metadata.promptBytes),
      toolSchemaBytes: positiveNumber(metadata.toolSchemaBytes),
      inputTokens: positiveNumber(usage.inputTokens),
      outputTokens: positiveNumber(usage.outputTokens),
      cachedInputTokens: positiveNumber(usage.cachedInputTokens),
      costUsd: positiveNumber(metadata.estimatedCostUsd),
      requestedTools: stringArray(metadata.requestedToolCalls),
      serverToolUse: numberRecord(metadata.serverToolUse),
      urlCitationCount: positiveNumber(metadata.urlCitationCount),
      sections: promptSections(metadata.promptSections),
    };
  });
}

function criticalPathDiagnosis(input: { wallMs: number; modelMs: number; toolMs: number; uninstrumentedMs: number; calls: number }) {
  const recommendations: string[] = [];
  if (input.wallMs > 0 && input.modelMs / input.wallMs >= 0.6) recommendations.push("model-bound; reduce prompt/tool-result size or extra rounds");
  if (input.wallMs > 0 && input.toolMs / input.wallMs >= 0.4) recommendations.push("tool-bound; inspect the slowest external call, caching, or result limits");
  if (input.calls >= 3) recommendations.push(`${input.calls} model calls amplified latency`);
  if (input.wallMs > 0 && input.uninstrumentedMs / input.wallMs >= 0.25) recommendations.push("material uninstrumented time remains in queue/context/delivery work");
  return recommendations.join("; ") || "no structural bottleneck threshold fired; compare with a known-good run";
}

function promptSections(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const section = record(item);
    const name = stringValue(section.name);
    return name ? [{ name, bytes: positiveNumber(section.bytes), estimatedTokens: positiveNumber(section.estimatedTokens) }] : [];
  });
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function numberRecord(value: unknown) { return Object.fromEntries(Object.entries(record(value)).flatMap(([key, item]) => { const number = positiveNumber(item); return number > 0 ? [[key, number]] : []; })); }
function positiveNumber(value: unknown) { const number = typeof value === "string" ? Number(value) : value; return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : 0; }
function formatServerToolUse(value: Record<string, number>) { return Object.entries(value).map(([key, count]) => `${key}:${count}`).join(","); }
function formatDuration(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`; }
function formatBytes(value: number) { return value >= 1024 ? `${(value / 1024).toFixed(1)}KB` : `${Math.round(value)}B`; }
function formatNumber(value: number) { return new Intl.NumberFormat("en-US").format(value); }
function humanize(value: string) { return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
