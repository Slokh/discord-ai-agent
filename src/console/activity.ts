type DashboardRecord = Record<string, unknown>;

type StoryTone = "active" | "success" | "warning" | "danger" | "neutral";
export type ActivityWorkState = "active" | "waiting" | "blocked" | "terminal" | null;

export type ActivityStory = {
  id: string;
  kind: "conversation" | "code_change" | "improvement" | "release" | "message" | "system";
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
  branchName: string | null;
  pullRequestUrl: string | null;
  sourceUrl: string | null;
  responseUrl: string | null;
  responseKind: string | null;
  hasParent: boolean;
  improvementCaseId: string | null;
  relatedImprovementCaseIds: string[];
  failureReason: string | null;
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
  const executions = records(snapshot.executions);
  const tasks = records(snapshot.tasks);
  const taskById = new Map(tasks.map((task) => [string(task.taskId), task]));
  const executionByTaskId = new Map(executions.flatMap((execution) => {
    const taskId = nullableString(execution.taskId);
    return taskId ? [[taskId, execution] as const] : [];
  }));

  const active = tasks.map((task) => activeTaskStory(task, executionByTaskId.get(string(task.taskId))));
  for (const execution of executions) {
    const taskId = nullableString(execution.taskId);
    if (taskId && taskById.has(taskId)) continue;
    active.push(activeExecutionStory(execution));
  }

  const projected = correlateImprovementWork(mergeOpenImprovements(
    records(snapshot.activity).map(projectRecentStory),
    records(record(snapshot.improvements).cases),
  )).filter((story) => story.rollupKey !== "embedding");
  projected.push(...records(snapshot.messages).map(messageStory));
  for (const deployment of records(snapshot.deployments)) projected.push(releaseStory(deployment));
  const rolledUp = rollupSystemStories(projected);
  const sorted = rolledUp.sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt));
  return foldActiveImprovementWork({
    active: active.filter((story) => story.rollupKey !== "embedding")
      .sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt)),
    recent: sorted,
  });
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

export function retainOpenImprovementActivity(
  activity: { active: ActivityStory[]; recent: ActivityStory[] },
  improvements: unknown,
): { active: ActivityStory[]; recent: ActivityStory[] } {
  const activeIds = new Set(activity.active.map((story) => `${story.kind}:${story.id}`));
  const stories = [...new Map([...activity.recent, ...activity.active].map((story) => [`${story.kind}:${story.id}`, story])).values()];
  const merged = correlateImprovementWork(mergeOpenImprovements(stories, records(record(improvements).cases)));
  return foldActiveImprovementWork({
    active: merged.filter((story) => activeIds.has(`${story.kind}:${story.id}`)),
    recent: merged.filter((story) => !activeIds.has(`${story.kind}:${story.id}`))
      .sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt)),
  });
}

function summarizeStory(story: ActivityStory): ActivitySummary {
  const summary: Partial<ActivityStory> = { ...story };
  delete summary.runs;
  delete summary.technicalEvents;
  return summary as ActivitySummary;
}

function activeTaskStory(task: DashboardRecord, execution?: DashboardRecord): ActivityStory {
  const status = string(task.status, "running");
  const currentStep = nullableString(task.currentStep);
  const latestEvent = nullableString(execution?.latestEvent);
  const system = task.taskType === "improvement_report";
  return storyDefaults({
    id: `task-${string(task.taskId)}`,
    kind: system ? "system" : "code_change",
    category: system ? "system" : "product",
    title: string(task.title, system ? "Background work" : "Untitled code change"),
    status,
    tone: "active",
    workState: "active",
    summary: nullableString(task.statusMessage) ?? (currentStep ? humanize(currentStep) : "Work is in progress"),
    occurredAt: task.updatedAt,
    startedAt: task.startedAt ?? task.createdAt,
    branchName: nullableString(task.branchName),
    pullRequestUrl: nullableString(task.pullRequestUrl) ?? nullableString(execution?.pullRequestUrl),
    sourceUrl: nullableString(task.sourceUrl),
    responseUrl: nullableString(task.responseUrl),
    responseKind: nullableString(task.responseKind),
    improvementCaseId: nullableString(task.improvementCaseId),
    failureReason: nullableString(task.failureReason),
    rollupKey: system ? "improvement_report" : null,
    technicalEvents: latestEvent ? [technicalEvent(`active-task-${string(task.taskId)}`, latestEvent, "info", task.updatedAt)] : [],
  });
}

function activeExecutionStory(execution: DashboardRecord): ActivityStory {
  const latestEvent = nullableString(execution.latestEvent);
  const system = Boolean(nullableString(execution.rollupKey) || latestEvent?.startsWith("background."));
  const status = string(execution.status, "running");
  return storyDefaults({
    id: `execution-${string(execution.executionId)}`,
    kind: system ? "system" : nullableString(execution.taskId) ? "code_change" : "conversation",
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
  const kind: ActivityStory["kind"] = rawKind === "code_change"
    ? "code_change"
    : rawKind === "improvement"
      ? "improvement"
      : system ? "system" : "conversation";
  const detail = nullableString(source.detail);
  const milestone = detail ?? events[0]?.name ?? executionStatus;
  const outcome = activityOutcome(kind, executionStatus, deliveryState, responseStatus, milestone);
  const durationMs = nullableNumber(source.durationMs);
  return storyDefaults({
    id: string(source.id),
    kind,
    category: system ? "system" : outcome.tone === "danger" || outcome.tone === "warning" ? "failure" : "product",
    title: string(source.title, "Activity"),
    authorLabel: kind === "conversation" ? nullableString(source.authorLabel) : null,
    status: outcome.status,
    tone: outcome.tone,
    workState: kind === "improvement" ? improvementWorkState(source) : null,
    summary: outcome.summary,
    occurredAt: source.occurredAt ?? source.createdAt,
    startedAt: source.startedAt ?? source.occurredAt ?? source.createdAt,
    durationMs,
    latencyTone: latencyTone(durationMs),
    attempts: nullableNumber(source.attempts),
    branchName: nullableString(source.branchName),
    pullRequestUrl: nullableString(source.pullRequestUrl),
    sourceUrl: nullableString(source.sourceUrl),
    responseUrl: nullableString(source.responseUrl),
    responseKind: nullableString(source.responseKind),
    hasParent: Boolean(source.hasParent),
    improvementCaseId: nullableString(source.improvementCaseId),
    relatedImprovementCaseIds: strings(source.relatedImprovementCaseIds),
    failureReason: nullableString(source.failureReason),
    rollupKey: nullableString(source.rollupKey),
    technicalEvents: events,
  });
}

function activityOutcome(
  kind: ActivityStory["kind"],
  status: string,
  deliveryState: string | null,
  responseStatus: string | null,
  milestone: string,
): { status: string; tone: StoryTone; summary: string } {
  if (kind === "improvement") {
    const eventFailed = milestone.endsWith("failed") || milestone.endsWith("stalled") || milestone.endsWith("inconclusive");
    const warning = eventFailed || status === "needs_evidence" || milestone.includes("awaiting_");
    return {
      status,
      tone: status === "resolved" ? "success" : warning ? "warning" : "neutral",
      summary: improvementMilestone(milestone),
    };
  }
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
  if (isFailure(status)) return {
    status,
    tone: "danger",
    summary: kind === "code_change" ? "Code change failed" : "Background work failed",
  };
  if (status === "cancelled" || status === "partial") return { status, tone: "warning", summary: humanize(status) };
  return {
    status,
    tone: isSuccess(status) ? "success" : "neutral",
    summary: kind === "code_change" ? "Code change completed" : "Background work completed",
  };
}

function correlateImprovementWork(stories: ActivityStory[]): ActivityStory[] {
  const parent = new Map<string, string>();
  const find = (caseId: string): string => {
    const current = parent.get(caseId) ?? caseId;
    if (current === caseId) return current;
    const root = find(current);
    parent.set(caseId, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const story of stories) {
    const caseIds = storyCaseIds(story);
    for (const caseId of caseIds) parent.set(caseId, parent.get(caseId) ?? caseId);
    for (const caseId of caseIds.slice(1)) union(caseIds[0]!, caseId);
  }

  const improvementGroups = new Map<string, ActivityStory[]>();
  for (const story of stories) {
    if (story.kind !== "improvement") continue;
    const caseId = storyCaseIds(story)[0];
    if (!caseId) continue;
    const root = find(caseId);
    improvementGroups.set(root, [...(improvementGroups.get(root) ?? []), story]);
  }
  const improvementByRoot = new Map<string, ActivityStory>();
  const secondaryImprovements = new Set<ActivityStory>();
  for (const [root, group] of improvementGroups) {
    const ordered = [...group].sort((left, right) => timestamp(left.startedAt) - timestamp(right.startedAt) || left.id.localeCompare(right.id));
    const canonical = ordered[0]!;
    canonical.relatedImprovementCaseIds = [...new Set(ordered.flatMap(storyCaseIds))];
    for (const related of ordered.slice(1)) {
      mergeImprovementStory(canonical, related);
      secondaryImprovements.add(related);
    }
    improvementByRoot.set(root, canonical);
  }

  return stories.filter((story) => {
    if (secondaryImprovements.has(story)) return false;
    if (story.kind === "improvement") return true;
    if (story.kind !== "code_change" && story.kind !== "conversation" && story.kind !== "system") return true;
    const caseId = storyCaseIds(story)[0];
    const improvement = caseId ? improvementByRoot.get(find(caseId)) : undefined;
    if (!improvement) return true;
    mergeImprovementEvidence(improvement, story);
    return false;
  });
}

function storyCaseIds(story: ActivityStory): string[] {
  return [...new Set([story.improvementCaseId, ...strings(story.relatedImprovementCaseIds)].filter((value): value is string => Boolean(value)))];
}

function mergeImprovementStory(canonical: ActivityStory, related: ActivityStory) {
  const canonicalPriority = workStatePriority(canonical.workState);
  const relatedPriority = workStatePriority(related.workState);
  if (relatedPriority > canonicalPriority || relatedPriority === canonicalPriority && timestamp(related.occurredAt) > timestamp(canonical.occurredAt)) {
    canonical.status = related.status;
    canonical.workState = related.workState;
    canonical.tone = related.tone;
    canonical.category = related.category;
    canonical.summary = related.summary;
  }
  mergeImprovementEvidence(canonical, related);
}

function mergeImprovementEvidence(improvement: ActivityStory, evidence: ActivityStory) {
  improvement.pullRequestUrl ??= evidence.pullRequestUrl;
  improvement.branchName ??= evidence.branchName;
  improvement.durationMs ??= evidence.durationMs;
  improvement.latencyTone ??= evidence.latencyTone;
  improvement.technicalEvents = [...improvement.technicalEvents, ...evidence.technicalEvents]
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
    .slice(0, 16);
  improvement.failureReason = preferFailureReason(improvement.failureReason, evidence.failureReason);
  if (timestamp(evidence.occurredAt) > timestamp(improvement.occurredAt)) improvement.occurredAt = evidence.occurredAt;
}

function workStatePriority(state: ActivityWorkState): number {
  return state === "blocked" ? 4 : state === "active" ? 3 : state === "waiting" ? 2 : state === "terminal" ? 1 : 0;
}

function mergeOpenImprovements(stories: ActivityStory[], cases: DashboardRecord[]): ActivityStory[] {
  const byCaseId = new Map(stories.flatMap((story) => story.kind === "improvement" && story.improvementCaseId
    ? [[story.improvementCaseId, story] as const]
    : []));
  for (const improvement of cases) {
    const caseId = string(improvement.caseId);
    if (!caseId) continue;
    const workState = improvementWorkState(improvement);
    const existing = byCaseId.get(caseId);
    const occurredAt = improvement.lastProgressAt ?? improvement.lastSeenAt;
    const summary = nullableString(improvement.blocker) ?? nullableString(improvement.nextAction);
    if (existing) {
      existing.relatedImprovementCaseIds = [...new Set([
        ...strings(existing.relatedImprovementCaseIds),
        caseId,
        ...strings(improvement.relatedImprovementCaseIds),
      ])];
      existing.workState = workState;
      existing.title = string(improvement.title, existing.title);
      existing.status = string(improvement.status, existing.status);
      existing.tone = improvementTone(workState, existing.tone);
      existing.category = workState === "blocked" ? "failure" : "product";
      existing.summary = summary ? humanize(summary) : existing.summary;
      existing.pullRequestUrl ??= nullableString(improvement.pullRequestUrl);
      if (timestamp(occurredAt) > timestamp(existing.occurredAt)) existing.occurredAt = occurredAt;
      continue;
    }
    const story = storyDefaults({
      id: `improvement-${caseId}`,
      kind: "improvement",
      category: workState === "blocked" ? "failure" : "product",
      title: string(improvement.title, "Untitled improvement"),
      status: string(improvement.status, "open"),
      tone: improvementTone(workState, "neutral"),
      workState,
      summary: summary ? humanize(summary) : "No next action recorded",
      occurredAt,
      startedAt: improvement.firstSeenAt ?? occurredAt,
      pullRequestUrl: nullableString(improvement.pullRequestUrl),
      improvementCaseId: caseId,
      relatedImprovementCaseIds: [...new Set([caseId, ...strings(improvement.relatedImprovementCaseIds)])],
    });
    stories.push(story);
    byCaseId.set(caseId, story);
  }
  return stories;
}

function preferFailureReason(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current || current === "The repair retries reached their limit.") return candidate;
  return current;
}

function foldActiveImprovementWork(activity: { active: ActivityStory[]; recent: ActivityStory[] }): {
  active: ActivityStory[];
  recent: ActivityStory[];
} {
  const improvementByCase = new Map(activity.recent.flatMap((story) => story.kind === "improvement"
    ? storyCaseIds(story).map((caseId) => [caseId, story] as const)
    : []));
  const pinned = new Set<ActivityStory>();
  const active = activity.active.filter((story) => {
    if (!story.improvementCaseId || !["code_change", "system"].includes(story.kind)) return true;
    const improvement = improvementByCase.get(story.improvementCaseId);
    if (!improvement) return true;
    improvement.pullRequestUrl ??= story.pullRequestUrl;
    improvement.branchName ??= story.branchName;
    improvement.occurredAt = timestamp(story.occurredAt) > timestamp(improvement.occurredAt) ? story.occurredAt : improvement.occurredAt;
    if (improvement.workState !== "blocked" && improvement.workState !== "waiting") {
      improvement.workState = "active";
      improvement.tone = "active";
    }
    pinned.add(improvement);
    return false;
  });
  const pinnedStories = [...pinned];
  return {
    active: [...active, ...pinnedStories].sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt)),
    recent: activity.recent.filter((story) => !pinned.has(story)),
  };
}

function improvementWorkState(value: DashboardRecord): Exclude<ActivityWorkState, null> {
  const status = string(value.status);
  const automationState = string(value.automationState);
  if (["resolved", "dismissed"].includes(status) || automationState === "complete") return "terminal";
  if (automationState === "blocked" || string(value.severity) === "critical") return "blocked";
  if (automationState === "waiting" || ["needs_evidence", "verifying"].includes(status)) return "waiting";
  return "active";
}

function improvementTone(workState: ActivityWorkState, fallback: StoryTone): StoryTone {
  if (workState === "blocked") return "danger";
  if (workState === "waiting") return "warning";
  if (workState === "active") return "active";
  return fallback;
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
    authorLabel: null, durationMs: null, latencyTone: null, attempts: null, branchName: null, pullRequestUrl: null, workState: null,
    sourceUrl: null, responseUrl: null, responseKind: null, hasParent: false, improvementCaseId: null,
    relatedImprovementCaseIds: [], failureReason: null, rollupKey: null,
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

export function improvementMilestone(eventName: string): string {
  const labels: Record<string, string> = {
    "case.created": "Reported", "case.open": "Reopened", "case.needs_evidence": "Needs evidence",
    "case.actionable": "Marked actionable", "case.in_progress": "Moved into progress",
    "case.verifying": "Started verification", "case.resolved": "Resolved", "case.dismissed": "Dismissed",
    "case.merged": "Merged into another case", "triage.applied": "Triaged",
    "contract.accepted": "Accepted an executable contract", "work.started": "Code work started",
    "work.pull_request_opened": "Pull request opened", "work.completed": "Code work completed",
    "work.failed": "Code work failed", "verification.passed": "Verification passed",
    "verification.failed": "Verification failed", "verification.inconclusive": "Verification inconclusive",
    "reconciliation.assessment_queued": "Assessment queued", "reconciliation.repair_queued": "Repair queued",
    "reconciliation.awaiting_reporter": "Waiting for reporter context",
    "reconciliation.awaiting_operator": "Waiting for operator decision",
    "reconciliation.awaiting_contract": "Waiting for an executable contract",
    "reconciliation.stalled": "Automation stalled",
  };
  return labels[eventName] ?? eventLabel(eventName);
}

function systemRollupTitle(key: string): string {
  const labels: Record<string, string> = {
    discord_crawl: "Discord crawls", reminder_delivery: "Reminder deliveries",
    improvement_report: "Improvement assessments",
  };
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
  return ["succeeded", "completed", "resolved", "verified", "no_changes"].includes(status);
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

function record(value: unknown): DashboardRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as DashboardRecord : {};
}

function string(value: unknown, fallback = ""): string { return value == null ? fallback : String(value); }
function nullableString(value: unknown): string | null { return value == null || value === "" ? null : String(value); }
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => item != null && item !== "").map(String) : [];
}
function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function timestamp(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value ?? 0)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
