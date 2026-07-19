import type { ProcessRunStatus } from "../db/repositories.js";
import type { RunSpan } from "./runTypes.js";

export function bottleneckSpan(spans: RunSpan[]) {
  const span = spans
    .filter((item) => item.durationMs != null)
    .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))[0];
  return span && span.durationMs != null
    ? { name: span.name, durationMs: span.durationMs }
    : null;
}

export function isTerminal(status: ProcessRunStatus) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "no_changes" ||
    status === "cancelled"
  );
}
