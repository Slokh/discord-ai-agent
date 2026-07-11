import { useMemo } from "react";
import type { RunEvent, RunSnapshot } from "./types.js";

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
};

type ModelCallView = {
  id: string;
  appRevision: string;
  purpose: string;
  model: string;
  status: "succeeded" | "failed";
  durationMs: number | null;
  promptBytes: number;
  toolSchemaBytes: number;
  toolCount: number;
  outputChars: number;
  finishReason: string;
  costUsd: number;
  usage: ModelUsage;
  requestedTools: string[];
  offeredTools: string[];
  error: string | null;
};

export function ModelCalls({ snapshot }: { snapshot: RunSnapshot }) {
  const calls = useMemo(() => modelCallsFromSnapshot(snapshot), [snapshot]);
  const totals = calls.reduce(
    (sum, call) => ({
      durationMs: sum.durationMs + (call.durationMs ?? 0),
      inputTokens: sum.inputTokens + call.usage.inputTokens,
      outputTokens: sum.outputTokens + call.usage.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + call.usage.cachedInputTokens,
      costUsd: sum.costUsd + call.costUsd,
    }),
    { durationMs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
  );

  if (calls.length === 0) {
    return <section className="panel"><p className="notice">No model-call telemetry was recorded for this run.</p></section>;
  }

  return (
    <section className="panel model-calls-panel">
      <div className="panel-heading">
        <div className="panel-title"><h3>Model calls</h3></div>
        <span className="model-call-count">{calls.length} calls</span>
      </div>
      <div className="model-call-summary" aria-label="Model call totals">
        <Summary label="Input" value={formatNumber(totals.inputTokens)} />
        <Summary label="Cached" value={formatNumber(totals.cachedInputTokens)} />
        <Summary label="Output" value={formatNumber(totals.outputTokens)} />
        <Summary label="Model time" value={formatDuration(totals.durationMs)} />
        <Summary label="Cost" value={totals.costUsd > 0 ? `$${totals.costUsd.toFixed(5)}` : "unknown"} />
      </div>
      <div className="model-call-list">
        {calls.map((call, index) => (
          <article className={`model-call-card ${call.status}`} key={call.id}>
            <header>
              <div>
                <span>Call {index + 1}</span>
                <strong>{humanize(call.purpose)}</strong>
              </div>
              <div className="model-call-timing">
                <strong>{formatDuration(call.durationMs)}</strong>
                <span>{call.status}</span>
              </div>
            </header>
            <dl className="model-call-facts">
              <Fact label="Model" value={call.model} />
              <Fact label="Revision" value={call.appRevision} />
              <Fact label="Finish" value={call.finishReason} />
              <Fact label="Prompt" value={`${formatBytes(call.promptBytes)} + ${formatBytes(call.toolSchemaBytes)} tools`} />
              <Fact label="Tools offered" value={`${call.toolCount} (${formatBytes(call.toolSchemaBytes)})`} />
              <Fact label="Tokens" value={`${formatNumber(call.usage.inputTokens)} in · ${formatNumber(call.usage.outputTokens)} out · ${formatNumber(call.usage.cachedInputTokens)} cached`} />
              <Fact label="Output" value={`${formatNumber(call.outputChars)} chars`} />
              <Fact label="Cost" value={call.costUsd > 0 ? `$${call.costUsd.toFixed(6)}` : "unknown"} />
            </dl>
            {call.requestedTools.length > 0 && (
              <div className="model-call-tools"><span>Requested tools</span><code>{call.requestedTools.join(", ")}</code></div>
            )}
            {call.offeredTools.length > 0 && (
              <details>
                <summary>Tools offered ({call.offeredTools.length})</summary>
                <code>{call.offeredTools.join(", ")}</code>
              </details>
            )}
            {call.error && <p className="notice bad">{call.error}</p>}
            <details>
              <summary>Raw telemetry</summary>
              <pre>{JSON.stringify(snapshot.events.find((event) => event.id === call.id)?.metadata ?? {}, null, 2)}</pre>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}

export function modelCallsFromSnapshot(snapshot: Pick<RunSnapshot, "events">): ModelCallView[] {
  const observed = snapshot.events.filter((event) => event.name === "agent.model.call.completed" || event.name === "agent.model.call.failed");
  const events = observed.length > 0 ? observed : snapshot.events.filter((event) => event.name === "agent.model.round.complete");
  return events.map(modelCallFromEvent);
}

function modelCallFromEvent(event: RunEvent): ModelCallView {
  const metadata = event.metadata;
  const usage = record(metadata.usage);
  return {
    id: event.id,
    appRevision: stringValue(metadata.appRevision) ?? "unknown",
    purpose: stringValue(metadata.purpose) ?? (metadata.round ? `tool_selection_round_${metadata.round}` : "model_call"),
    model: stringValue(metadata.model) ?? stringValue(metadata.requestedModel) ?? "unknown",
    status: event.name.endsWith("failed") || event.level === "error" ? "failed" : "succeeded",
    durationMs: event.durationMs,
    promptBytes: numberValue(metadata.promptBytes),
    toolSchemaBytes: numberValue(metadata.toolSchemaBytes),
    toolCount: numberValue(metadata.toolCount),
    outputChars: numberValue(metadata.outputChars),
    finishReason: stringValue(metadata.finishReason) ?? "unknown",
    costUsd: numberValue(metadata.estimatedCostUsd),
    usage: {
      inputTokens: numberValue(usage.inputTokens),
      outputTokens: numberValue(usage.outputTokens),
      totalTokens: numberValue(usage.totalTokens),
      reasoningTokens: numberValue(usage.reasoningTokens),
      cachedInputTokens: numberValue(usage.cachedInputTokens),
    },
    requestedTools: stringArray(metadata.requestedToolCalls),
    offeredTools: stringArray(metadata.offeredTools),
    error: stringValue(metadata.error),
  };
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatNumber(value: number) {
  return value > 0 ? new Intl.NumberFormat().format(value) : "0";
}

function formatBytes(value: number) {
  if (value <= 0) return "unknown";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
}

function formatDuration(value: number | null) {
  if (value == null) return "unknown";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function humanize(value: string) {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
