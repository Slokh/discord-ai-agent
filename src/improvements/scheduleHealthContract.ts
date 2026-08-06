import { createHash } from "node:crypto";

export type ScheduleHealthIssueKind = "run_failed" | "repeated_partial" | "overdue" | "stuck" | "auto_paused";
export type ScheduleHealthProofStatus = "passed" | "failed" | "inconclusive";

const SCHEDULE_HEALTH_REFERENCE = /^schedule-health:(run_failed|repeated_partial|overdue|stuck|auto_paused):[a-f0-9]{16}$/;

export function isScheduleHealthReference(reference: string) {
  return SCHEDULE_HEALTH_REFERENCE.test(reference);
}

export function scheduleHealthReference(kind: ScheduleHealthIssueKind, scheduleId: string) {
  return `schedule-health:${kind}:${shortHash(scheduleId)}`;
}

export function shortScheduleHealthIdentity(value: string) {
  return shortHash(value);
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
