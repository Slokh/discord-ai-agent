import { useMemo, useState } from "react";
import { Copy, Tag } from "regen-ui";
import { fetchArtifact } from "./api.js";
import { criticalPathFromSnapshot } from "./criticalPath.js";
import { modelCallsFromSnapshot, type ModelCallView, type PromptSectionView } from "./modelCalls.js";
import { RunFeedback } from "./runFeedback.js";
import type { AgentTranscriptMessage, RunArtifact, RunSnapshot } from "./types.js";

export function PromptDebugger({ snapshot }: { snapshot: RunSnapshot }) {
  const calls = useMemo(() => modelCallsFromSnapshot(snapshot), [snapshot]);
  const criticalPath = useMemo(() => criticalPathFromSnapshot(snapshot), [snapshot]);
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
    <div className="prompt-debugger">
      <section className="panel debugger-intro">
        <div>
          <span className="eyebrow">Observed execution</span>
          <h3>Prompt debugger</h3>
          <p>Inspect what the model received, what it returned, which tools ran, and where the runtime went. Captures are authenticated, automatically secret-redacted, and do not include private chain-of-thought.</p>
        </div>
        <div className="debugger-summary" aria-label="Model call totals">
          <Summary label="Calls" value={String(calls.length)} />
          <Summary label="Input" value={formatNumber(totals.inputTokens)} />
          <Summary label="Cached" value={formatPercent(totals.inputTokens ? totals.cachedInputTokens / totals.inputTokens : null)} />
          <Summary label="Model time" value={formatDuration(totals.durationMs)} />
          <Summary label="Cost" value={totals.costUsd > 0 ? `$${totals.costUsd.toFixed(5)}` : "unknown"} />
        </div>
      </section>

      <CriticalPathView summary={criticalPath} />

      <section className="panel model-calls-panel debugger-calls">
        <div className="panel-heading">
          <div className="panel-title"><h3>Model rounds</h3></div>
          <span className="model-call-count">{calls.length} calls</span>
        </div>
        <div className="model-call-list">
          {calls.map((call, index) => (
            <ModelRound key={call.id} snapshot={snapshot} call={call} index={index} />
          ))}
        </div>
      </section>

      <RunFeedback runId={snapshot.run.runId} />
    </div>
  );
}

function CriticalPathView({ summary }: { summary: ReturnType<typeof criticalPathFromSnapshot> }) {
  const max = Math.max(1, ...summary.items.map((item) => item.durationMs));
  return (
    <section className="panel critical-path-panel">
      <div className="panel-heading">
        <div className="panel-title"><h3>Critical path</h3></div>
        <span>{formatDuration(summary.durationMs)} wall time</span>
      </div>
      <p className="critical-verdict">{summary.verdict}</p>
      <div className="critical-path-grid">
        <div className="critical-bars">
          {summary.items.slice(0, 8).map((item) => (
            <div className={`critical-row ${item.category}`} key={item.id}>
              <div><strong>{item.label}</strong><small>{item.detail}</small></div>
              <div className="critical-duration"><strong>{formatDuration(item.durationMs)}</strong><span>{Math.round(item.share * 100)}%</span></div>
              <div className="critical-track"><span style={{ width: `${Math.max(2, item.durationMs / max * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="critical-recommendations">
          <span className="eyebrow">What to inspect next</span>
          <ul>{summary.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}</ul>
        </div>
      </div>
    </section>
  );
}

function ModelRound({ snapshot, call, index }: { snapshot: RunSnapshot; call: ModelCallView; index: number }) {
  const promptArtifact = artifactForCall(snapshot, call, "model_prompt");
  const responseArtifact = artifactForCall(snapshot, call, "model_response");
  const activity = roundActivity(snapshot.agentTranscript ?? [], call.round);
  const totalSectionBytes = call.promptSections.reduce((sum, section) => sum + section.bytes, 0);
  return (
    <article className={`model-call-card debugger-call ${call.status}`}>
      <header>
        <div>
          <span>Call {index + 1}{call.round != null ? ` · round ${call.round}` : ""}</span>
          <strong>{humanize(call.purpose)}</strong>
        </div>
        <div className="model-call-timing"><strong>{formatDuration(call.durationMs)}</strong><span>{call.status}</span></div>
      </header>

      <div className="debugger-call-grid">
        <dl className="model-call-facts">
          <Fact label="Model" value={call.model} />
          <Fact label="Revision" value={call.appRevision} />
          <Fact label="Finish" value={call.finishReason} />
          <Fact label="Prompt" value={formatBytes(call.promptBytes)} />
          <Fact label="Tool schemas" value={`${call.toolCount} · ${formatBytes(call.toolSchemaBytes)}`} />
          <Fact label="Tokens" value={`${formatNumber(call.usage.inputTokens)} in · ${formatNumber(call.usage.outputTokens)} out`} />
          <Fact label="Cache" value={formatPercent(call.usage.inputTokens ? call.usage.cachedInputTokens / call.usage.inputTokens : null)} />
          <Fact label="Cost" value={call.costUsd > 0 ? `$${call.costUsd.toFixed(6)}` : "unknown"} />
          {Object.keys(call.serverToolUse).length > 0 && <Fact label="Server tools" value={formatServerToolUse(call.serverToolUse)} />}
          {call.urlCitationCount > 0 && <Fact label="URL citations" value={formatNumber(call.urlCitationCount)} />}
        </dl>
        <PromptSections sections={call.promptSections} totalBytes={totalSectionBytes} />
      </div>

      {call.requestedTools.length > 0 && <div className="model-call-tools"><span>Requested tools</span><code>{call.requestedTools.join(", ")}</code></div>}
      {call.toolSchemas.length > 0 && (
        <details className="debugger-tool-schemas">
          <summary>Offered tool schemas ({call.toolSchemas.length})</summary>
          <div>{[...call.toolSchemas].sort((a, b) => b.bytes - a.bytes).map((tool) => <span key={`${tool.type}-${tool.name}`}><code>{tool.name}</code><small>{tool.type} · {formatBytes(tool.bytes)}</small></span>)}</div>
        </details>
      )}
      {activity.length > 0 && <RoundActivity messages={activity} />}
      {call.error && <p className="notice bad">{call.error}</p>}

      <div className="debugger-artifact-grid">
        <DebuggerArtifact runId={snapshot.run.runId} artifact={promptArtifact} title="Exact prompt and schemas" mode="prompt" />
        <DebuggerArtifact runId={snapshot.run.runId} artifact={responseArtifact} title="Exact model response" mode="response" />
      </div>
    </article>
  );
}

function formatServerToolUse(usage: Record<string, number>) {
  return Object.entries(usage).map(([name, count]) => `${humanize(name)}: ${formatNumber(count)}`).join(" · ");
}

function PromptSections({ sections, totalBytes }: { sections: PromptSectionView[]; totalBytes: number }) {
  if (sections.length === 0) return <div className="prompt-sections empty-sections"><span>Section telemetry unavailable for this older run.</span></div>;
  return (
    <div className="prompt-sections">
      <div><strong>Prompt composition</strong><span>estimated tokens</span></div>
      {[...sections].sort((a, b) => b.bytes - a.bytes).map((section) => (
        <div className="prompt-section-row" key={section.name}>
          <span title={humanize(section.name)}>{humanize(section.name)}</span>
          <div><i style={{ width: `${Math.max(2, totalBytes ? section.bytes / totalBytes * 100 : 0)}%` }} /></div>
          <strong>{formatNumber(section.estimatedTokens)}</strong>
          <small>{formatBytes(section.bytes)}</small>
        </div>
      ))}
    </div>
  );
}

function RoundActivity({ messages }: { messages: AgentTranscriptMessage[] }) {
  return (
    <details className="round-activity">
      <summary>Tool activity in this round ({messages.length})</summary>
      <div>{messages.map((message) => <article key={message.id} className={message.role}><div><Tag intent={message.role === "tool" ? "accent" : "neutral"}>{message.role}</Tag><strong>{String(message.metadata.toolName ?? humanize(message.role))}</strong>{message.metadata.durationMs != null && <span>{formatDuration(Number(message.metadata.durationMs))}</span>}</div><pre>{transcriptContent(message)}</pre></article>)}</div>
    </details>
  );
}

function DebuggerArtifact({ runId, artifact, title, mode }: { runId: string; artifact: RunArtifact | null; title: string; mode: "prompt" | "response" }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseJson(content), [content]);
  async function load() {
    if (!artifact || loading) return;
    setLoading(true);
    setError(null);
    try { setContent(await fetchArtifact(runId, artifact.artifactId)); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    finally { setLoading(false); }
  }
  return (
    <section className="debugger-artifact">
      <div><strong>{title}</strong>{artifact?.redacted && <Tag intent="warning">secret-redacted</Tag>}</div>
      {!artifact ? <p>Capture unavailable for this older model call.</p> : !content ? <button type="button" onClick={() => void load()}>{loading ? "Loading…" : `Load ${mode}`}</button> : (
        <>
          <div className="debugger-artifact-actions"><Copy value={content} title={`Copy ${title}`} /><span>{formatBytes(artifact.sizeBytes)}</span></div>
          {mode === "prompt" ? <PromptArtifactContent value={parsed} fallback={content} /> : <ResponseArtifactContent value={parsed} fallback={content} />}
        </>
      )}
      {error && <p className="notice bad">{error}</p>}
    </section>
  );
}

function PromptArtifactContent({ value, fallback }: { value: Record<string, unknown> | null; fallback: string }) {
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  if (!value || messages.length === 0) return <pre>{fallback}</pre>;
  return (
    <div className="captured-messages">
      {messages.map((item, index) => {
        const message = record(item);
        return <article key={index}><div><Tag intent="neutral">{String(message.role ?? "message")}</Tag><strong>{humanize(String(message.section ?? "context"))}</strong><span>#{Number(message.index ?? index) + 1}</span></div><pre>{renderContent(message.content)}</pre></article>;
      })}
      <details><summary>Raw captured request</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
    </div>
  );
}

function ResponseArtifactContent({ value, fallback }: { value: Record<string, unknown> | null; fallback: string }) {
  if (!value) return <pre>{fallback}</pre>;
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : [];
  return <div className="captured-response"><pre>{String(value.content ?? "(empty response content)")}</pre>{toolCalls.length > 0 && <details open><summary>Tool calls ({toolCalls.length})</summary><pre>{JSON.stringify(toolCalls, null, 2)}</pre></details>}<details><summary>Response metadata</summary><pre>{JSON.stringify({ model: value.model, finishReason: value.finishReason, usage: value.usage, estimatedCostUsd: value.estimatedCostUsd }, null, 2)}</pre></details></div>;
}

function artifactForCall(snapshot: RunSnapshot, call: ModelCallView, kind: string) {
  const explicitId = kind === "model_prompt" ? call.promptArtifactId : call.responseArtifactId;
  return snapshot.artifacts.find((artifact) => artifact.artifactId === explicitId) ?? snapshot.artifacts.find((artifact) => artifact.kind === kind && artifact.metadata.callId === call.callId) ?? null;
}

function roundActivity(messages: AgentTranscriptMessage[], round: number | null) {
  if (round == null) return [];
  return messages.filter((message) => Number(message.metadata.round) === round && (message.role === "assistant" || message.role === "tool"));
}

function transcriptContent(message: AgentTranscriptMessage) {
  return message.parts.map((part) => {
    if (typeof part === "string") return part;
    const data = record(part);
    return String(data.content ?? data.text ?? JSON.stringify(data, null, 2));
  }).join("\n").slice(0, 12_000);
}

function renderContent(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function parseJson(value: string): Record<string, unknown> | null {
  if (!value) return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function Summary({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function humanize(value: string) { return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatNumber(value: number) { return new Intl.NumberFormat().format(value); }
function formatBytes(value: number) { if (value <= 0) return "unknown"; return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`; }
function formatDuration(value: number | null) { if (value == null || !Number.isFinite(value)) return "unknown"; return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`; }
function formatPercent(value: number | null) { return value == null ? "unknown" : `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`; }
