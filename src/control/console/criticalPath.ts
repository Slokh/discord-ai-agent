import { modelCallsFromSnapshot } from "./modelCalls.js";
import type { AgentTranscriptMessage, RunSnapshot } from "./types.js";

export type CriticalPathItem = {
  id: string;
  category: "model" | "tool" | "other";
  label: string;
  durationMs: number;
  share: number;
  detail: string;
};

export type CriticalPathSummary = {
  durationMs: number;
  modelDurationMs: number;
  toolDurationMs: number;
  unattributedDurationMs: number;
  cachedInputRate: number | null;
  items: CriticalPathItem[];
  verdict: string;
  recommendations: string[];
};

export function criticalPathFromSnapshot(snapshot: RunSnapshot): CriticalPathSummary {
  const calls = modelCallsFromSnapshot(snapshot);
  const durationMs = snapshot.run.durationMs ?? elapsedDuration(snapshot.run.startedAt, snapshot.run.completedAt ?? snapshot.generatedAt);
  const modelItems = calls
    .filter((call): call is typeof call & { durationMs: number } => call.durationMs != null && call.durationMs > 0)
    .map((call, index) => ({
      id: `model-${call.callId}`,
      category: "model" as const,
      label: `Model call ${index + 1}: ${humanize(call.purpose)}`,
      durationMs: call.durationMs,
      detail: `${call.model} · ${formatNumber(call.usage.inputTokens)} input tokens · ${formatBytes(call.promptBytes)} prompt`,
    }));
  const toolItems = toolTimingMessages(snapshot.agentTranscript ?? []).map((message) => ({
    id: `tool-${message.id}`,
    category: "tool" as const,
    label: `Tool: ${String(message.metadata.toolName ?? "unknown")}`,
    durationMs: Number(message.metadata.durationMs),
    detail: toolDetail(message),
  }));
  const modelDurationMs = modelItems.reduce((total, item) => total + item.durationMs, 0);
  const toolDurationMs = toolItems.reduce((total, item) => total + item.durationMs, 0);
  const unattributedDurationMs = Math.max(0, durationMs - modelDurationMs - toolDurationMs);
  const baseItems: Array<Omit<CriticalPathItem, "share">> = [...modelItems, ...toolItems];
  if (unattributedDurationMs > 0) {
    baseItems.push({
      id: "other-runtime",
      category: "other",
      label: "Queue, context, delivery, and uninstrumented work",
      durationMs: unattributedDurationMs,
      detail: "Run duration not accounted for by completed model and tool calls.",
    });
  }
  const items = baseItems
    .map((item) => ({ ...item, share: durationMs > 0 ? item.durationMs / durationMs : 0 }))
    .sort((left, right) => right.durationMs - left.durationMs);
  const inputTokens = calls.reduce((total, call) => total + call.usage.inputTokens, 0);
  const cachedInputTokens = calls.reduce((total, call) => total + call.usage.cachedInputTokens, 0);
  const cachedInputRate = inputTokens > 0 ? Math.min(1, cachedInputTokens / inputTokens) : null;
  const dominant = items[0] ?? null;
  const verdict = dominant
    ? `${dominant.label} dominated the observed critical path at ${formatDuration(dominant.durationMs)} (${Math.round(dominant.share * 100)}%).`
    : "No timed model or tool work was recorded for this run.";
  const recommendations: string[] = [];
  if (durationMs > 0 && modelDurationMs / durationMs >= 0.6) recommendations.push("Model-bound: reduce prompt/tool-result size, avoid extra rounds, or use a faster model tier.");
  if (durationMs > 0 && toolDurationMs / durationMs >= 0.4) recommendations.push("Tool-bound: inspect the slowest external call and add caching, batching, or tighter result limits.");
  if (calls.length >= 3) recommendations.push(`${calls.length} model calls amplified latency; check whether routing, recovery, or final synthesis can be collapsed.`);
  if (cachedInputRate != null && cachedInputRate < 0.3 && calls.some((call) => call.promptBytes >= 20_000)) recommendations.push("Large prompts had low cache reuse; verify that stable context stays at the prefix and dynamic context stays late.");
  if (unattributedDurationMs > durationMs * 0.25) recommendations.push("A material share is unattributed; add or repair spans around queueing, context assembly, or Discord delivery.");
  if (recommendations.length === 0 && dominant) recommendations.push("No obvious structural bottleneck threshold fired; compare this run with a known-good baseline before tuning.");
  return { durationMs, modelDurationMs, toolDurationMs, unattributedDurationMs, cachedInputRate, items, verdict, recommendations };
}

function toolTimingMessages(messages: AgentTranscriptMessage[]) {
  return messages.filter((message) => message.role === "tool" && Number.isFinite(Number(message.metadata.durationMs)) && Number(message.metadata.durationMs) > 0);
}

function toolDetail(message: AgentTranscriptMessage) {
  const outputChars = Number(message.metadata.outputChars);
  const round = Number(message.metadata.round);
  return [Number.isFinite(round) ? `round ${round}` : null, Number.isFinite(outputChars) ? `${formatNumber(outputChars)} output chars` : null]
    .filter(Boolean)
    .join(" · ") || "Completed local tool call";
}

function elapsedDuration(start: string, end: string) {
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function humanize(value: string) {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function formatBytes(value: number) {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}
