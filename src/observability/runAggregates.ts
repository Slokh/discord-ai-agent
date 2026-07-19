import type { RunSummary } from "./runTypes.js";

export type RunCount = {
  name: string;
  count: number;
};

export type RunListAggregate = {
  total: number;
  active: number;
  attention: number;
  terminal: number;
  byStatus: RunCount[];
  byKind: RunCount[];
  codegenDiagnoses: RunCount[];
};

export function buildRunListAggregate(runs: RunSummary[]): RunListAggregate {
  return {
    total: runs.length,
    active: runs.filter((run) => !isTerminalRunStatus(run.status)).length,
    attention: runs.filter((run) => run.status === "failed" || run.status === "cancelled" || run.status === "no_changes").length,
    terminal: runs.filter((run) => isTerminalRunStatus(run.status)).length,
    byStatus: countBy(runs, (run) => run.status),
    byKind: countBy(runs, (run) => run.kind),
    codegenDiagnoses: countBy(
      runs
        .map((run) => codegenFailureDiagnosisCategory(run.metadata.failureDiagnosis))
        .filter((category): category is string => Boolean(category)),
      (category) => category
    )
  };
}

export function isTerminalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}

function countBy<T>(items: T[], keyForItem: (item: T) => string): RunCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyForItem(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

function codegenFailureDiagnosisCategory(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const category = (value as Record<string, unknown>).category;
  return typeof category === "string" && category.trim() ? category.trim() : null;
}
