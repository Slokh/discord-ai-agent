import { Activity, AlertCircle, Clock3, Link2, MessageSquare, SlidersHorizontal } from "lucide-react";
import { Copy, Status, Tag } from "regen-ui";
import { RunFeedback } from "./runFeedback.js";
import type { AgentTranscriptMessage, RunSnapshot, RunStatus } from "./types.js";

export function Overview({ snapshot }: { snapshot: RunSnapshot }) {
  const latencyRows = snapshot.spans.filter((span): span is typeof span & { durationMs: number } => span.durationMs != null).sort((a, b) => b.durationMs - a.durationMs);
  const totalDuration = latencyRows.reduce((sum, span) => sum + span.durationMs, 0);
  const slowest = latencyRows[0] ?? null;
  const signalEvents = snapshot.events.filter((event) => event.level === "error" || event.level === "warn").slice(-4).reverse();
  const relatedRuns = snapshot.relatedRuns ?? [];
  const transcript = snapshot.agentTranscript ?? [];
  return (
    <div className="overview-grid">
      <section className="panel insight-panel"><PanelTitle icon={<Activity />} title="Summary" /><div className="diagnostics">{snapshot.diagnostics.length ? snapshot.diagnostics.map((item) => <p key={item}>{item}</p>) : <p>No diagnostics recorded yet.</p>}</div></section>
      <section className="panel metrics-panel">
        <Metric label="Status" value={snapshot.run.status} tone={snapshot.run.status === "failed" ? "bad" : snapshot.run.status === "succeeded" ? "good" : "normal"} />
        <Metric label="Duration" value={formatDuration(snapshot.run.durationMs)} />
        <Metric label="Slowest" value={slowest ? `${slowest.name} (${formatDuration(slowest.durationMs)})` : "none"} tone={slowest ? "info" : "normal"} />
        <Metric label="Events" value={snapshot.events.length} />
        {transcript.length > 0 && <Metric label="Transcript" value={transcript.length} tone="info" />}
        {relatedRuns.length > 0 && <Metric label="Related" value={relatedRuns.length} tone={relatedRuns.some((run) => !isTerminal(run.status)) ? "info" : "normal"} />}
      </section>
      {transcript.length > 0 && <section className="panel wide"><PanelTitle icon={<MessageSquare />} title="Agent Transcript" /><AgentTranscriptPreview messages={transcript} /></section>}
      {relatedRuns.length > 0 && <section className="panel wide"><PanelTitle icon={<Link2 />} title="Related Runs" /><div className="related-run-list">{relatedRuns.map((run) => <a className={`related-run-card ${run.status}`} href={runHref(run.runId)} key={run.runId}><div className="related-run-card-top"><StatusTag status={run.status} /><Tag intent="neutral">{run.kind}</Tag><span>{formatDuration(run.durationMs)}</span></div><strong>{run.title}</strong><p>{run.summary ?? run.runId}</p></a>)}</div></section>}
      <section className="panel wide"><PanelTitle icon={<Clock3 />} title="Latency" /><LatencyBreakdown rows={latencyRows} totalDuration={totalDuration} /></section>
      <section className="panel"><PanelTitle icon={<AlertCircle />} title="Signals" />{signalEvents.length === 0 ? <Empty label="No warnings or errors" /> : <div className="signal-list">{signalEvents.map((event) => <div key={event.id} className={`signal-item ${event.level}`}><strong>{humanize(event.name)}</strong><span>{event.summary ?? event.source}</span><small>{formatOffset(snapshot.run.startedAt, event.createdAt)}</small></div>)}</div>}</section>
      <section className="panel"><PanelTitle icon={<SlidersHorizontal />} title="Details" /><dl className="facts"><Fact label="Current step" value={snapshot.run.currentStep ?? "none"} /><Fact label="Source" value={snapshot.run.source} /><Fact label="Run id" value={snapshot.run.runId} copy />{snapshot.run.messageId && <Fact label="Message id" value={snapshot.run.messageId} copy />}<Fact label="Artifacts" value={String(snapshot.artifacts.length)} /><Fact label="Terminal" value={`${snapshot.terminal.lineCount} lines`} /></dl></section>
      <RunFeedback runId={snapshot.run.runId} />
    </div>
  );
}

function AgentTranscriptPreview({ messages }: { messages: AgentTranscriptMessage[] }) {
  return <div className="agent-transcript-preview">{messages.slice(-6).map((message) => <article key={message.id} className={`agent-transcript-row ${message.role}`}><div><strong>{transcriptTitle(message)}</strong><span>{[message.role, stringValue(message.metadata.source), formatDate(message.createdAt)].filter(Boolean).join(" · ")}</span></div><p>{transcriptSummary(message)}</p></article>)}</div>;
}

function LatencyBreakdown({ rows, totalDuration }: { rows: Array<RunSnapshot["spans"][number] & { durationMs: number }>; totalDuration: number }) {
  if (!rows.length) return <Empty label="No timed spans recorded yet" />;
  const max = Math.max(1, ...rows.map((row) => row.durationMs));
  return <div className="latency-table" role="table" aria-label="Latency by run phase"><div className="latency-row latency-head" role="row"><span>Step</span><span>Duration</span><span>Share</span></div>{rows.map((row) => <div className="latency-row" role="row" key={row.id}><div className="latency-step"><strong>{row.name}</strong><small>{row.source}</small></div><strong>{formatDuration(row.durationMs)}</strong><div className="latency-share"><span>{totalDuration ? `${Math.round(row.durationMs / totalDuration * 100)}%` : "0%"}</span><div className="latency-track"><div className={`latency-bar ${row.status}`} style={{ width: `${Math.max(3, row.durationMs / max * 100)}%` }} /></div></div></div>)}</div>;
}

function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) { return <div className="panel-title">{icon}<h3>{title}</h3></div>; }
function Metric({ label, value, tone = "normal" }: { label: string; value: string | number; tone?: "normal" | "bad" | "good" | "info" }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function Fact({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) { return <div><dt>{label}</dt><dd><span>{value}</span>{copy && <Copy value={value} title={`Copy ${label}`} />}</dd></div>; }
function Empty({ label }: { label: string }) { return <div className="state empty"><Status type="info" /><span>{label}</span></div>; }
function StatusTag({ status }: { status: RunStatus }) { const intent = status === "succeeded" ? "positive" : status === "failed" || status === "cancelled" ? "negative" : status === "no_changes" ? "warning" : "accent"; return <Tag dot intent={intent}>{status}</Tag>; }
function isTerminal(status: RunStatus) { return ["succeeded", "failed", "cancelled", "no_changes"].includes(status); }
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function transcriptTitle(message: AgentTranscriptMessage) { return stringValue(message.metadata.title) || humanize(message.role); }
function transcriptSummary(message: AgentTranscriptMessage) {
  const summary = stringValue(message.metadata.summary);
  if (summary) return summary;
  const text = message.parts.map((part) => typeof part === "string" ? part : stringValue((part as Record<string, unknown> | null)?.text)).filter(Boolean).join(" ");
  return text.trim() || "No content recorded.";
}
function runHref(runId: string) { const prefix = window.location.pathname.startsWith("/console/") ? "/console/runs" : "/runs"; return `${prefix}/${encodeURIComponent(runId)}?tab=timeline`; }
function humanize(value: string) { return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function formatDate(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; }
function formatOffset(start: string, value: string) { const ms = new Date(value).getTime() - new Date(start).getTime(); return Number.isFinite(ms) ? `+${formatDuration(Math.max(0, ms))}` : ""; }
function formatDuration(value: number | null | undefined) { if (value == null || !Number.isFinite(value)) return "--"; if (value < 1_000) return `${Math.round(value)}ms`; if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`; return `${Math.floor(value / 60_000)}m ${Math.round(value % 60_000 / 1_000)}s`; }
