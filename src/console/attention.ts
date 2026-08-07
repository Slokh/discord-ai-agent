export type OperatorAttentionItem = {
  id: string;
  kind: "service" | "execution" | "improvement" | "producer";
  severity: "critical" | "high" | "medium";
  title: string;
  detail: string;
  link: string | null;
};

export function deriveOperatorAttention(
  snapshot: Record<string, unknown>,
  input: { now?: Date; stalledExecutionMs?: number } = {},
) {
  const now = input.now ?? new Date();
  const stalledExecutionMs = input.stalledExecutionMs ?? 11 * 60_000;
  const items: OperatorAttentionItem[] = [];

  for (const value of array(snapshot.services)) {
    const service = record(value);
    const status = text(service?.status);
    if (!service || !status || !["offline", "stale", "degraded"].includes(status)) continue;
    const component = text(service.component) ?? "service";
    items.push({
      id: `service-${component}`,
      kind: "service",
      severity: status === "offline" ? "high" : "medium",
      title: `${capitalize(component)} is ${status}`,
      detail: text(service.source) === "kubernetes" ? "Kubernetes readiness" : "Application heartbeat",
      link: null,
    });
  }

  for (const value of array(snapshot.executions)) {
    const execution = record(value);
    const updatedAt = instant(execution?.updatedAt);
    if (!execution || !updatedAt || now.getTime() - updatedAt.getTime() <= stalledExecutionMs) continue;
    const executionId = text(execution.executionId) ?? "unknown";
    items.push({
      id: `execution-${executionId}`,
      kind: "execution",
      severity: "high",
      title: `${text(execution.title) ?? "Prompt"} appears stalled`,
      detail: text(execution.latestEvent)?.replaceAll(".", " · ") ?? "No recent runtime progress",
      link: githubLink(execution.pullRequestUrl),
    });
  }

  const improvements = record(snapshot.improvements);
  for (const value of array(improvements?.cases)) {
    const improvement = record(value);
    const automationState = text(improvement?.automationState);
    const severity = text(improvement?.severity);
    if (!improvement || (automationState !== "blocked" && severity !== "critical")) continue;
    const caseId = text(improvement.caseId) ?? "unknown";
    items.push({
      id: `improvement-${caseId}`,
      kind: "improvement",
      severity: severity === "critical" ? "critical" : "high",
      title: text(improvement.title) ?? "Improvement needs attention",
      detail: (text(improvement.blocker) ?? text(improvement.nextAction) ?? "Operator decision required").replaceAll("_", " "),
      link: githubLink(improvement.pullRequestUrl),
    });
  }

  for (const value of array(snapshot.producers)) {
    const producer = record(value);
    const status = text(producer?.status);
    if (!producer || !status || !["failed", "blocked", "stale", "timed_out"].includes(status)) continue;
    const trigger = text(producer.trigger) ?? "proof producer";
    items.push({
      id: `producer-${trigger}`,
      kind: "producer",
      severity: "high",
      title: `${trigger.replaceAll("_", " ")} ${status.replaceAll("_", " ")}`,
      detail: text(producer.outcomeCode)?.replaceAll("_", " ") ?? "Verification evidence is unavailable",
      link: null,
    });
  }

  const priority = { critical: 0, high: 1, medium: 2 } as const;
  return items.sort((left, right) => priority[left.severity] - priority[right.severity]
    || left.title.localeCompare(right.title)).slice(0, 12);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function instant(value: unknown) {
  if (value instanceof Date) return value;
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function githubLink(value: unknown) {
  const link = text(value);
  return link?.startsWith("https://github.com/") ? link : null;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
