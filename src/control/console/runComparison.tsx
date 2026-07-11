import { useEffect, useMemo, useState } from "react";
import { fetchRunSnapshot } from "./api.js";
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
    </section>
  );
}

function comparisonFacts(snapshot: RunSnapshot) {
  const calls = modelCallsFromSnapshot(snapshot);
  return {
    durationMs: snapshot.run.durationMs ?? 0,
    modelCalls: calls.length,
    cost: calls.reduce((sum, call) => sum + call.costUsd, 0),
    inputTokens: calls.reduce((sum, call) => sum + call.usage.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.usage.outputTokens, 0),
    errors: snapshot.events.filter((event) => event.level === "error").length,
    tools: snapshot.events.filter((event) => event.category === "tool").length,
  };
}

function ComparisonColumn({ label, run, facts }: { label: string; run: RunSummary; facts: ReturnType<typeof comparisonFacts> }) {
  return <article><span>{label}</span><h4>{run.title}</h4><dl><dt>Status</dt><dd>{run.status}</dd><dt>Duration</dt><dd>{(facts.durationMs / 1000).toFixed(2)}s</dd><dt>Model calls</dt><dd>{facts.modelCalls}</dd><dt>Cost</dt><dd>${facts.cost.toFixed(6)}</dd><dt>Tokens</dt><dd>{facts.inputTokens} in / {facts.outputTokens} out</dd><dt>Tool events</dt><dd>{facts.tools}</dd><dt>Errors</dt><dd>{facts.errors}</dd></dl></article>;
}
