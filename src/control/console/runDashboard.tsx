import type { RunSummary } from "./types.js";

export function RunDashboard({ runs }: { runs: RunSummary[] }) {
  const durations = runs.map((run) => run.durationMs).filter((value): value is number => value != null).sort((a, b) => a - b);
  const failed = runs.filter((run) => run.status === "failed" || run.status === "cancelled").length;
  const revisions = revisionQuality(runs);
  return <section className="run-dashboard" aria-label="Aggregate run dashboard">
    <div className="run-dashboard-totals">
      <DashboardMetric label="Runs" value={String(runs.length)} />
      <DashboardMetric label="Failure rate" value={runs.length ? `${((failed / runs.length) * 100).toFixed(1)}%` : "0%"} />
      <DashboardMetric label="Median" value={formatDuration(percentile(durations, 0.5))} />
      <DashboardMetric label="P95" value={formatDuration(percentile(durations, 0.95))} />
    </div>
    {revisions.length > 0 && <div className="revision-quality" role="table" aria-label="Quality by deployed revision">
      <div className="revision-quality-row revision-quality-head" role="row"><span>Revision</span><span>Runs</span><span>Failed</span><span>P95</span></div>
      {revisions.map((revision) => <div className="revision-quality-row" role="row" key={revision.name}>
        <code title={revision.name}>{revision.name.slice(0, 10)}</code><span>{revision.runs}</span><span>{revision.failed}</span><span>{formatDuration(revision.p95)}</span>
      </div>)}
    </div>}
  </section>;
}

function DashboardMetric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function percentile(values: number[], fraction: number) { return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0 : 0; }
function formatDuration(ms: number) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`; }

export function revisionQuality(runs: RunSummary[]) {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const name = typeof run.metadata.appRevision === "string" && run.metadata.appRevision ? run.metadata.appRevision : "unknown";
    groups.set(name, [...(groups.get(name) ?? []), run]);
  }
  return [...groups.entries()].map(([name, grouped]) => ({
    name,
    runs: grouped.length,
    failed: grouped.filter((run) => run.status === "failed" || run.status === "cancelled").length,
    p95: percentile(grouped.map((run) => run.durationMs).filter((value): value is number => value != null).sort((a, b) => a - b), 0.95),
  })).sort((left, right) => right.runs - left.runs || left.name.localeCompare(right.name));
}
