import { useEffect, useMemo, useState } from "react";
import { fetchRunSnapshot } from "./api.js";
import { criticalPathFromSnapshot } from "./criticalPath.js";
import { modelCallsFromSnapshot } from "./modelCalls.js";
import type { RunSnapshot, RunSummary } from "./types.js";

export function RunComparison({ current, runs }: { current: RunSnapshot; runs: RunSummary[] }) {
  const candidates = runs.filter((run) => run.runId !== current.run.runId);
  const [runId, setRunId] = useState(candidates[0]?.runId ?? "");
  const [comparison, setComparison] = useState<RunSnapshot | null>(null);
  useEffect(() => {
    if (!runId) { setComparison(null); return; }
    void fetchRunSnapshot(runId).then(setComparison).catch(() => setComparison(null));
  }, [runId]);
  const left = useMemo(() => comparisonFacts(current), [current]);
  const right = useMemo(() => comparison ? comparisonFacts(comparison) : null, [comparison]);
  return (
    <section className="panel comparison-panel">
      <div className="panel-heading"><div className="panel-title"><h3>Compare runs</h3></div><select aria-label="Comparison run" value={runId} onChange={(event) => setRunId(event.target.value)}><option value="">Select a run</option>{candidates.map((run) => <option key={run.runId} value={run.runId}>{run.title} · {run.status}</option>)}</select></div>
      <div className="comparison-grid">
        <ComparisonColumn label="Current" run={current.run} facts={left} />
        {comparison && right ? <ComparisonColumn label="Baseline" run={comparison.run} facts={right} /> : <p className="notice">Choose another run to compare.</p>}
      </div>
      {comparison && right && <ComparisonDeltas current={left} baseline={right} />}
      {comparison && <PurposeComparison current={current} baseline={comparison} />}
    </section>
  );
}

export function comparisonFacts(snapshot: RunSnapshot) {
  const calls = modelCallsFromSnapshot(snapshot);
  const criticalPath = criticalPathFromSnapshot(snapshot);
  return {
    durationMs: snapshot.run.durationMs ?? 0,
    modelCalls: calls.length,
    cost: calls.reduce((sum, call) => sum + call.costUsd, 0),
    inputTokens: calls.reduce((sum, call) => sum + call.usage.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.usage.outputTokens, 0),
    cachedInputTokens: calls.reduce((sum, call) => sum + call.usage.cachedInputTokens, 0),
    promptBytes: calls.reduce((sum, call) => sum + call.promptBytes, 0),
    toolSchemaBytes: calls.reduce((sum, call) => sum + call.toolSchemaBytes, 0),
    modelDurationMs: criticalPath.modelDurationMs,
    toolDurationMs: criticalPath.toolDurationMs,
    errors: snapshot.events.filter((event) => event.level === "error").length,
    tools: snapshot.events.filter((event) => event.category === "tool").length,
  };
}

function ComparisonColumn({ label, run, facts }: { label: string; run: RunSummary; facts: ReturnType<typeof comparisonFacts> }) {
  const cacheRate = facts.inputTokens > 0 ? facts.cachedInputTokens / facts.inputTokens : null;
  return <article><span>{label}</span><h4>{run.title}</h4><dl><dt>Status</dt><dd>{run.status}</dd><dt>Wall time</dt><dd>{formatDuration(facts.durationMs)}</dd><dt>Model / tool time</dt><dd>{formatDuration(facts.modelDurationMs)} / {formatDuration(facts.toolDurationMs)}</dd><dt>Model calls</dt><dd>{facts.modelCalls}</dd><dt>Cost</dt><dd>{formatCost(facts.cost)}</dd><dt>Tokens</dt><dd>{formatNumber(facts.inputTokens)} in / {formatNumber(facts.outputTokens)} out</dd><dt>Cache hit rate</dt><dd>{cacheRate == null ? "unknown" : `${Math.round(cacheRate * 100)}%`}</dd><dt>Prompt / schemas</dt><dd>{formatBytes(facts.promptBytes)} / {formatBytes(facts.toolSchemaBytes)}</dd><dt>Tool events</dt><dd>{facts.tools}</dd><dt>Errors</dt><dd>{facts.errors}</dd></dl></article>;
}

type ComparisonFacts = ReturnType<typeof comparisonFacts>;

function ComparisonDeltas({ current, baseline }: { current: ComparisonFacts; baseline: ComparisonFacts }) {
  const rows = [
    deltaRow("Wall time", current.durationMs, baseline.durationMs, formatDuration),
    deltaRow("Model time", current.modelDurationMs, baseline.modelDurationMs, formatDuration),
    deltaRow("Tool time", current.toolDurationMs, baseline.toolDurationMs, formatDuration),
    deltaRow("Input tokens", current.inputTokens, baseline.inputTokens, formatNumber),
    deltaRow("Prompt bytes", current.promptBytes, baseline.promptBytes, formatBytes),
    deltaRow("Cost", current.cost, baseline.cost, formatCost),
    deltaRow("Model calls", current.modelCalls, baseline.modelCalls, formatNumber),
  ];
  return <div className="comparison-deltas"><div><span className="eyebrow">Current minus baseline</span><h4>Performance deltas</h4></div><div>{rows.map((row) => <span className={row.delta > 0 ? "regressed" : row.delta < 0 ? "improved" : "unchanged"} key={row.label}><small>{row.label}</small><strong>{row.formatted}</strong><em>{formatDeltaPercent(row.delta, row.baseline)}</em></span>)}</div></div>;
}

function PurposeComparison({ current, baseline }: { current: RunSnapshot; baseline: RunSnapshot }) {
  const rows = purposeComparisonRows(current, baseline);
  if (rows.length === 0) return null;
  return <div className="comparison-purposes"><div><span className="eyebrow">Round-level diagnosis</span><h4>Model calls by purpose</h4></div><div className="comparison-table-wrap"><table><thead><tr><th>Purpose</th><th>Calls</th><th>Duration</th><th>Input</th><th>Cost</th></tr></thead><tbody>{rows.map((row) => <tr key={row.purpose}><th>{humanize(row.purpose)}</th><td>{row.current.calls} / {row.baseline.calls}</td><td>{formatPair(row.current.durationMs, row.baseline.durationMs, formatDuration)}</td><td>{formatPair(row.current.inputTokens, row.baseline.inputTokens, formatNumber)}</td><td>{formatPair(row.current.cost, row.baseline.cost, formatCost)}</td></tr>)}</tbody></table></div><small>Each pair is current / baseline. Use this to locate the round that introduced a latency, token, or cost regression.</small></div>;
}

export function purposeComparisonRows(current: RunSnapshot, baseline: RunSnapshot) {
  const currentFacts = callsByPurpose(current);
  const baselineFacts = callsByPurpose(baseline);
  return [...new Set([...currentFacts.keys(), ...baselineFacts.keys()])].sort().map((purpose) => ({
    purpose,
    current: currentFacts.get(purpose) ?? emptyPurposeFacts(),
    baseline: baselineFacts.get(purpose) ?? emptyPurposeFacts(),
  }));
}

function callsByPurpose(snapshot: RunSnapshot) {
  const values = new Map<string, ReturnType<typeof emptyPurposeFacts>>();
  for (const call of modelCallsFromSnapshot(snapshot)) {
    const fact = values.get(call.purpose) ?? emptyPurposeFacts();
    fact.calls += 1;
    fact.durationMs += call.durationMs ?? 0;
    fact.inputTokens += call.usage.inputTokens;
    fact.cost += call.costUsd;
    values.set(call.purpose, fact);
  }
  return values;
}

function emptyPurposeFacts() { return { calls: 0, durationMs: 0, inputTokens: 0, cost: 0 }; }
function deltaRow(label: string, current: number, baseline: number, formatter: (value: number) => string) { const delta = current - baseline; return { label, delta, baseline, formatted: `${delta > 0 ? "+" : ""}${formatter(delta)}` }; }
function formatPair(current: number, baseline: number, formatter: (value: number) => string) { return `${formatter(current)} / ${formatter(baseline)}`; }
function formatDeltaPercent(delta: number, baseline: number) { return baseline > 0 ? `${delta > 0 ? "+" : ""}${Math.round(delta / baseline * 100)}%` : delta === 0 ? "0%" : "new"; }
function formatDuration(value: number) { const absolute = Math.abs(value); const formatted = absolute >= 1000 ? `${(absolute / 1000).toFixed(2)}s` : `${Math.round(absolute)}ms`; return value < 0 ? `-${formatted}` : formatted; }
function formatCost(value: number) { return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(6)}`; }
function formatBytes(value: number) { const absolute = Math.abs(value); const formatted = absolute >= 1024 ? `${(absolute / 1024).toFixed(1)} KB` : `${Math.round(absolute)} B`; return value < 0 ? `-${formatted}` : formatted; }
function formatNumber(value: number) { return new Intl.NumberFormat().format(value); }
function humanize(value: string) { return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
