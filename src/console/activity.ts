type DashboardRecord = Record<string, unknown>;

type StoryTone = "active" | "success" | "warning" | "danger" | "neutral";
export type ActivityWorkState = "active" | "waiting" | "blocked" | "terminal" | null;

export type ActivityStory = {
  id: string;
  kind: "conversation" | "release" | "message" | "system";
  category: "product" | "failure" | "system";
  title: string;
  authorLabel: string | null;
  status: string;
  tone: StoryTone;
  workState: ActivityWorkState;
  summary: string | null;
  occurredAt: unknown;
  startedAt: unknown;
  durationMs: number | null;
  latencyTone: "normal" | "slow" | "very_slow" | null;
  attempts: number | null;
  sourceUrl: string | null;
  responseUrl: string | null;
  responseKind: string | null;
  hasParent: boolean;
  rollupKey: string | null;
  runCount: number | null;
  successCount: number | null;
  failureCount: number | null;
  p95DurationMs: number | null;
  runs: Array<{ id: string; title: string; status: string; tone: StoryTone; durationMs: number | null; occurredAt: unknown }>;
  technicalEvents: Array<{ id: string; name: string; label: string; level: string; createdAt: unknown }>;
};

export type ActivitySummary = Omit<ActivityStory, "runs" | "technicalEvents">;

export function summarizeOperatorActivity(activity: { active: ActivityStory[]; recent: ActivityStory[] }): {
  active: ActivitySummary[];
  recent: ActivitySummary[];
} {
  return {
    active: activity.active.map(summarizeStory),
    recent: activity.recent.map(summarizeStory),
  };
}

export function deriveOperatorActivity(snapshot: DashboardRecord): { active: ActivityStory[]; recent: ActivityStory[] } {
  const active = records(snapshot.executions).map(activeExecutionStory)
    .filter((story) => story.rollupKey !== "embedding")
    .sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt));
  const projected = records(snapshot.activity).map(projectRecentStory)
    .filter((story) => story.rollupKey !== "embedding");
  projected.push(...records(snapshot.messages).map(messageStory));
  for (const deployment of records(snapshot.deployments)) projected.push(releaseStory(deployment));
  const recent = rollupSystemStories(projected)
    .sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt));
  return { active, recent };
}

function messageStory(message: DashboardRecord): ActivityStory {
  const embedded = Boolean(message.embedded);
  const skipReason = nullableString(message.embeddingSkipReason);
  const skipped = !embedded && Boolean(skipReason);
  return storyDefaults({
    id: `message-${string(message.id)}`,
    kind: "message",
    category: "system",
    title: string(message.preview, "Message content unavailable"),
    authorLabel: nullableString(message.authorLabel),
    status: embedded ? "embedded" : skipped ? "embedding_skipped" : "embedding_pending",
    tone: embedded ? "success" : skipped ? "neutral" : "warning",
    workState: embedded || skipped ? "terminal" : "waiting",
    summary: embedded ? "Embedded" : skipped ? "Agent interaction · embedding not needed" : "Embedding pending",
    occurredAt: message.createdAt,
    startedAt: message.createdAt,
    sourceUrl: nullableString(message.sourceUrl),
  });
}

function summarizeStory(story: ActivityStory): ActivitySummary {
  const summary: Partial<ActivityStory> = { ...story };
  delete summary.runs;
  delete summary.technicalEvents;
  return summary as ActivitySummary;
}

function activeExecutionStory(execution: DashboardRecord): ActivityStory {
  const latestEvent = nullableString(execution.latestEvent);
  const system = Boolean(nullableString(execution.rollupKey) || latestEvent?.startsWith("background."));
  const status = string(execution.status, "running");
  return storyDefaults({
    id: `execution-${string(execution.executionId)}`,
    kind: system ? "system" : "conversation",
    category: system ? "system" : "product",
    title: string(execution.title, system ? "Background work" : "Prompt"),
    authorLabel: system ? null : nullableString(execution.authorLabel),
    status,
    tone: "active",
    workState: "active",
    summary: nullableString(execution.requestPreview),
    occurredAt: execution.updatedAt,
    startedAt: execution.startedAt ?? execution.createdAt,
    sourceUrl: nullableString(execution.sourceUrl),
    responseUrl: nullableString(execution.responseUrl),
    responseKind: nullableString(execution.responseKind),
    hasParent: Boolean(execution.hasParent),
    rollupKey: nullableString(execution.rollupKey),
    technicalEvents: latestEvent ? [technicalEvent(`active-execution-${string(execution.executionId)}`, latestEvent, "info", execution.updatedAt)] : [],
  });
}

function projectRecentStory(source: DashboardRecord): ActivityStory {
  const rawKind = string(source.kind, "runtime");
  const executionStatus = string(source.status, "unknown");
  const deliveryState = nullableString(source.deliveryState);
  const responseStatus = nullableString(source.responseStatus);
  const events = records(source.events).map((event) => technicalEvent(
    string(event.id), string(event.name, "activity"), string(event.level, "info"), event.createdAt,
  ));
  const system = rawKind === "system" || rawKind === "runtime" && events.some((event) => event.name.startsWith("background."));
  const kind: ActivityStory["kind"] = system ? "system" : "conversation";
  const outcome = activityOutcome(kind, executionStatus, deliveryState, responseStatus);
  const durationMs = nullableNumber(source.durationMs);
  return storyDefaults({
    id: string(source.id),
    kind,
    category: system ? "system" : outcome.tone === "danger" || outcome.tone === "warning" ? "failure" : "product",
    title: string(source.title, "Activity"),
    authorLabel: kind === "conversation" ? nullableString(source.authorLabel) : null,
    status: outcome.status,
    tone: outcome.tone,
    summary: outcome.summary,
    occurredAt: source.occurredAt ?? source.createdAt,
    startedAt: source.startedAt ?? source.occurredAt ?? source.createdAt,
    durationMs,
    latencyTone: latencyTone(durationMs),
    attempts: nullableNumber(source.attempts),
    sourceUrl: nullableString(source.sourceUrl),
    responseUrl: nullableString(source.responseUrl),
    responseKind: nullableString(source.responseKind),
    hasParent: Boolean(source.hasParent),
    rollupKey: nullableString(source.rollupKey),
    technicalEvents: events,
  });
}

function activityOutcome(
  kind: ActivityStory["kind"],
  status: string,
  deliveryState: string | null,
  responseStatus: string | null,
): { status: string; tone: StoryTone; summary: string } {
  if (kind === "conversation") {
    if (isFailure(status)) return {
      status,
      tone: "danger",
      summary: deliveryState === "delivered" ? "Prompt failed · error delivered" : "Prompt failed",
    };
    if (deliveryState === "abandoned") return { status: "delivery_failed", tone: "danger", summary: "Reply generated · delivery failed" };
    if (deliveryState === "pending") return { status: "delivery_pending", tone: "warning", summary: "Reply ready · delivery pending" };
    if (responseStatus === "partial" || status === "partial") return {
      status: "partial",
      tone: "warning",
      summary: deliveryState === "delivered" ? "Partial reply delivered" : "Partial reply generated",
    };
    if (deliveryState === "delivered") return { status, tone: "success", summary: "Reply delivered" };
    return { status, tone: isSuccess(status) ? "success" : "neutral", summary: "Reply generated" };
  }
  if (isFailure(status)) return { status, tone: "danger", summary: "Background work failed" };
  if (status === "cancelled" || status === "partial") return { status, tone: "warning", summary: humanize(status) };
  return { status, tone: isSuccess(status) ? "success" : "neutral", summary: "Background work completed" };
}

function rollupSystemStories(stories: ActivityStory[]): ActivityStory[] {
  const groups = new Map<string, ActivityStory[]>();
  const ungrouped: ActivityStory[] = [];
  for (const story of stories) {
    if (story.category !== "system" || !story.rollupKey || story.tone === "danger" || story.tone === "warning") {
      ungrouped.push(story);
      continue;
    }
    const group = groups.get(story.rollupKey) ?? [];
    group.push(story);
    groups.set(story.rollupKey, group);
  }
  for (const [key, group] of groups) {
    if (group.length === 1) {
      ungrouped.push(group[0]!);
      continue;
    }
    const sorted = group.sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt));
    const durations = sorted.map((story) => story.durationMs).filter((value): value is number => value != null).sort((a, b) => a - b);
    const p95 = percentile(durations, 0.95);
    const failures = sorted.filter((story) => story.tone === "danger" || story.tone === "warning").length;
    const successes = sorted.length - failures;
    ungrouped.push(storyDefaults({
      id: `system-rollup-${key}`,
      kind: "system",
      category: "system",
      title: systemRollupTitle(key),
      status: failures ? "degraded" : "healthy",
      tone: failures ? "warning" : "success",
      summary: `${sorted.length} runs · ${failures ? `${failures} failed` : "no failures"}${p95 == null ? "" : ` · p95 ${formatDuration(p95)}`}`,
      occurredAt: sorted[0]!.occurredAt,
      startedAt: sorted.at(-1)!.startedAt,
      rollupKey: key,
      runCount: sorted.length,
      successCount: successes,
      failureCount: failures,
      p95DurationMs: p95,
      runs: sorted.map((story) => ({
        id: story.id, title: story.title, status: story.status, tone: story.tone,
        durationMs: story.durationMs, occurredAt: story.occurredAt,
      })),
    }));
  }
  return ungrouped;
}

function releaseStory(deployment: DashboardRecord): ActivityStory {
  const revision = string(deployment.revision, "unknown");
  return storyDefaults({
    id: `release-${string(deployment.deploymentId, revision)}`,
    kind: "release",
    category: "product",
    title: `Release ${revision.slice(0, 10)}`,
    status: "verified",
    tone: "success",
    workState: "terminal",
    summary: "Production rollout verified",
    occurredAt: deployment.verifiedAt,
    startedAt: deployment.verifiedAt,
  });
}

function storyDefaults(input: Partial<ActivityStory> & Pick<ActivityStory, "id" | "kind" | "category" | "title" | "status" | "tone" | "summary" | "occurredAt" | "startedAt">): ActivityStory {
  return {
    authorLabel: null, durationMs: null, latencyTone: null, attempts: null, workState: null,
    sourceUrl: null, responseUrl: null, responseKind: null, hasParent: false, rollupKey: null,
    runCount: null, successCount: null, failureCount: null, p95DurationMs: null,
    runs: [], technicalEvents: [], ...input,
  };
}

function technicalEvent(id: string, name: string, level: string, createdAt: unknown): ActivityStory["technicalEvents"][number] {
  return { id, name, label: eventLabel(name), level, createdAt };
}

export function eventLabel(name: string): string {
  const labels: Record<string, string> = {
    "agent.execution.started": "Execution started", "agent.execution.context_ready": "Context prepared",
    "agent.execution.response_stored": "Response stored", "agent.execution.succeeded": "Execution succeeded",
    "agent.execution.failed": "Execution failed", "agent.model.call.started": "Model call started",
    "agent.model.call.completed": "Model call completed", "agent.model.call.failed": "Model call failed",
    "agent.tool.started": "Tool started", "agent.tool.complete": "Tool completed",
    "agent.nanocodex.complete": "Agent completed", "agent.nanocodex.runtime_failed": "Agent runtime failed",
    "discord.delivery.intent_stored": "Delivery queued", "discord.delivery.recovered": "Delivery recovered",
    "background.job.started": "Background job started", "background.job.completed": "Background job completed",
    "background.job.failed": "Background job failed", "background.job.artifact": "Background result stored",
    "background.job.span": "Background job finished",
  };
  return labels[name] ?? humanize(name.replaceAll(".", " "));
}

function systemRollupTitle(key: string): string {
  const labels: Record<string, string> = { discord_crawl: "Discord crawls" };
  return labels[key] ?? `${humanize(key)} jobs`;
}

function latencyTone(durationMs: number | null): ActivityStory["latencyTone"] {
  if (durationMs == null) return null;
  if (durationMs >= 45_000) return "very_slow";
  if (durationMs >= 20_000) return "slow";
  return "normal";
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? null;
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.round(value / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function isFailure(status: string): boolean {
  return ["failed", "blocked", "timed_out", "timeout", "error"].includes(status);
}

function isSuccess(status: string): boolean {
  return ["succeeded", "completed", "verified"].includes(status);
}

function humanize(value: string): string {
  const words = value.replaceAll("_", " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Activity";
}

function records(value: unknown): DashboardRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is DashboardRecord => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function string(value: unknown, fallback = ""): string { return value == null ? fallback : String(value); }
function nullableString(value: unknown): string | null { return value == null || value === "" ? null : String(value); }
function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function timestamp(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value ?? 0)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
