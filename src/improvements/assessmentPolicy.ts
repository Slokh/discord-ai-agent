import type { ImprovementSignal } from "../db/types.js";
import { isScheduleHealthReference } from "./scheduleHealthContract.js";

const AUTOMATED_SOURCES = new Set([
  "runtime_detection",
  "deployment_detection",
  "ci_detection",
  "eval_detection",
]);

/** Observational incidents require semantic assessment; deterministic gates retain direct authority. */
export function improvementSignalRequiresAutonomousAssessment(
  signal: Pick<ImprovementSignal, "source" | "metadata">,
) {
  if (!AUTOMATED_SOURCES.has(signal.source)) return true;
  const detectionCode = signal.metadata?.detectionCode;
  return typeof detectionCode === "string" && isScheduleHealthReference(detectionCode);
}
