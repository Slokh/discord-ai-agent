import type { RunSummary } from "./types.js";

export function RunDashboard({ runs }: { runs: RunSummary[] }) {
  const durations = runs.map((run) => run.durationMs).filter((value): value is number => value != null).sort((a, b) => a - b);
  const failed = runs.filter((run) => run.status === "failed" || run.status === "cancelled").length;
  return <section className="run-dashboard" aria-label="Aggregate run dashboard">
    <DashboardMetric label="Runs" value={String(runs.length)} />
    <DashboardMetric label="Failure rate" value={runs.length ? `${((failed / runs.length) * 100).toFixed(1)}%` : "0%"} />
    <DashboardMetric label="Median" value={formatDuration(percentile(durations, 0.5))} />
    <DashboardMetric label="P95" value={formatDuration(percentile(durations, 0.95))} />
  </section>;
}

function DashboardMetric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function percentile(values: number[], fraction: number) { return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0 : 0; }
function formatDuration(ms: number) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`; }
