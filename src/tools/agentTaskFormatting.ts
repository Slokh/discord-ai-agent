import type { AppConfig } from "../config/env.js";
import type { AgentTaskRecord, SandboxCommandEvent, TaskEvent } from "../db/repositories.js";
import { truncateForDiscord } from "../util/text.js";

const AGENT_UPDATE_TITLE_MAX_CHARS = 80;
const ACTIVE_AGENT_TASK_STALE_MS = 15 * 60 * 1000;

export function agentUpdateTitleFromRequest(request: string, explicitTitle?: string | null): string {
  const source = explicitTitle?.trim() || request.trim();
  const normalized = normalizeAgentUpdateTitle(source);
  return truncateTitleAtWordBoundary(normalized, AGENT_UPDATE_TITLE_MAX_CHARS) || "Agent update";
}

function normalizeAgentUpdateTitle(value: string): string {
  let text = value
    .replace(/<a?:([a-z0-9_-]+):\d+>/gi, (_, name: string) => `${name.replace(/[_-]+/g, " ")} emoji`)
    .replace(/\bemoji\s+emoji\b/gi, "emoji")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  text = stripCodeUpdateChatter(text);
  text = text.replace(/\.\s+(?:then|after|when)\b.*$/i, "").trim();

  const insteadMatch = text.match(/^instead of\s+(.+?),\s*(?:can you\s+)?(?:please\s+)?(?:just\s+)?(.+)$/i);
  if (insteadMatch) {
    const oldBehavior = simplifyTitleFragment(insteadMatch[1] ?? "");
    const newBehavior = simplifyTitleFragment(insteadMatch[2] ?? "");
    text = `Replace ${oldBehavior} with ${newBehavior}`;
  }

  text = stripCodeUpdateChatter(text)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();

  return sentenceCaseTitle(text.replace(/[.!?]+$/g, ""));
}

function stripCodeUpdateChatter(value: string): string {
  return value
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?/i, "")
    .replace(/^(?:please\s+)?(?:update yourself|self[- ]?update)\s+(?:to\s+|so\s+that\s+)?/i, "")
    .replace(/\b(?:open|create|make)\s+(?:a\s+)?(?:github\s+)?(?:pull request|pr)\b[.!?]?/gi, "")
    .replace(/\b(?:in|as)\s+(?:a\s+)?(?:github\s+)?(?:pull request|pr)\b[.!?]?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function simplifyTitleFragment(value: string) {
  return value
    .replace(/^replying\s+["']?thinking\.{0,3}["']?\s+when prompted\b/i, "Thinking reply")
    .replace(/^react(?:ing)?\s+with\s+(?:the\s+)?(.+?\bemoji)\b(?:\s+to\s+the\s+prompt)?(?:\s+message)?/i, "$1")
    .replace(/\bwhen prompted\b/gi, "")
    .replace(/\bto the prompt(?: message)?\b/gi, "")
    .replace(/\bcan you\b/gi, "")
    .replace(/\bjust\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCaseTitle(value: string) {
  if (!value) return "";
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function truncateTitleAtWordBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return truncated || value.slice(0, maxChars).trim();
}

export function formatAgentTaskResult(input: {
  taskId: string;
  jobId: string | null;
  job?: AgentTaskRecord;
  timedOut?: boolean;
  taskEvents?: TaskEvent[];
  commandEvents?: SandboxCommandEvent[];
  runConsoleUrl?: string | null;
}) {
  const withRunConsole = (content: string) => appendAgentTaskRunConsoleLink(content, input.runConsoleUrl);
  if (input.timedOut) {
    const status = input.job?.status ? ` Current status: \`${input.job.status}\`.` : "";
    return withRunConsole(`I’m still working on that code change and do not have the final result yet.${status} Task ID: \`${input.taskId}\`.`);
  }

  const job = input.job;
  if (!job) {
    return withRunConsole(`Working on it...\n\nI’ll update this message with progress and the PR link when it’s ready.\nTask ID: \`${input.taskId}\`.`);
  }

  if (job.status === "succeeded" && job.prUrl) {
    const draftNote = job.draft ? " It opened as a draft." : "";
    return withRunConsole([`Done: ${job.prUrl}${draftNote}`, formatAgentTaskTimingSummary(input.taskEvents)].filter(Boolean).join("\n"));
  }

  if (job.status === "no_changes") {
    const diagnosis = agentTaskFailureDiagnosis(input.taskEvents);
    return withRunConsole([
      diagnosis
        ? `No PR opened: ${diagnosis.summary} Task ID: \`${input.taskId}\`.`
        : `No PR opened: the coding agent did not produce a code diff. Task ID: \`${input.taskId}\`.`,
      diagnosis?.finalResponse ? `Agent answer:\n${diagnosis.finalResponse}` : "",
      diagnosis?.nextAction ? `Next: ${diagnosis.nextAction}` : "",
      diagnosis?.finalResponse ? "" : formatLastCommandFailure(input.commandEvents)
    ]
      .filter(Boolean)
      .join("\n"));
  }

  if (job.status === "cancelled") {
    return withRunConsole([
      `That code change task was cancelled. Task ID: \`${input.taskId}\`.`,
      job.error ? truncateForDiscord(job.error, 500) : "",
      formatLastCommandFailure(input.commandEvents)
    ]
      .filter(Boolean)
      .join("\n"));
  }

  if (job.status === "failed") {
    const diagnosis = agentTaskFailureDiagnosis(input.taskEvents);
    return withRunConsole([
      diagnosis
        ? `No PR opened: ${diagnosis.summary}`
        : `No PR opened: the sandbox failed. ${truncateForDiscord(job.error ?? "unknown error", 900)}`,
      diagnosis?.nextAction ? `Next: ${diagnosis.nextAction}` : "",
      formatLastCommandFailure(input.commandEvents)
    ]
      .filter(Boolean)
      .join("\n"));
  }

  return withRunConsole(`I’m still working on that code change. Current status: \`${job.status}\`. Task ID: \`${input.taskId}\`.`);
}

export function agentTaskRunConsoleUrl(config: Pick<AppConfig, "controlUi">, taskId: string) {
  const publicUrl = config.controlUi?.publicUrl;
  if (!publicUrl) return null;
  return `${publicUrl}/runs/${encodeURIComponent(taskId)}`;
}

export function agentTaskAuditSummary(result: unknown) {
  if (!result || typeof result !== "object") return result;
  const typed = result as { taskId?: string; jobId?: string | null; job?: AgentTaskRecord };
  return {
    taskId: typed.taskId,
    jobId: typed.jobId,
    status: typed.job?.status,
    prUrl: typed.job?.prUrl,
    draft: typed.job?.draft,
    verifyPassed: typed.job?.verifyPassed,
    error: typed.job?.error
  };
}

export function formatAgentTaskLine(task: AgentTaskRecord) {
  const parts = [
    `\`${task.taskId}\``,
    task.status,
    task.currentStep ? `step=${task.currentStep}` : null,
    task.prUrl ? `PR=${task.prUrl}` : null,
    task.retriedFromTaskId ? `retryOf=${task.retriedFromTaskId}` : null,
    task.notificationError ? `notifyError=${truncateForDiscord(task.notificationError, 80)}` : null,
    `updated=${task.updatedAt.toISOString()}`
  ].filter(Boolean);
  return `${parts.join(" | ")}\n  ${truncateForDiscord(task.title, 180)}`;
}

export function formatActiveAgentTaskLine(task: AgentTaskRecord, nowMs: number) {
  const startedAt = task.startedAt ?? task.createdAt;
  const progressAt = task.progressUpdatedAt ?? task.updatedAt ?? startedAt;
  const elapsedMs = Math.max(0, nowMs - startedAt.getTime());
  const idleMs = Math.max(0, nowMs - progressAt.getTime());
  const stale = idleMs >= ACTIVE_AGENT_TASK_STALE_MS ? " | stale" : "";
  return `${formatAgentTaskLine(task)}\n  elapsed=${formatDurationMs(elapsedMs)} | idle=${formatDurationMs(idleMs)}${stale}`;
}

function agentTaskFailureDiagnosis(taskEvents: TaskEvent[] | undefined) {
  for (const event of [...(taskEvents ?? [])].reverse()) {
    const diagnosis = recordFromUnknown(event.metadata?.failureDiagnosis);
    const summary = typeof diagnosis?.summary === "string" ? diagnosis.summary.trim() : "";
    if (!summary) continue;
    const nextAction = typeof diagnosis?.nextAction === "string" ? diagnosis.nextAction.trim() : "";
    const finalResponse = typeof diagnosis?.finalResponse === "string" ? diagnosis.finalResponse.trim() : "";
    return {
      summary: truncateForDiscord(summary, 700),
      nextAction: nextAction ? truncateForDiscord(nextAction, 700) : "",
      finalResponse: finalResponse ? truncateForDiscord(finalResponse, 900) : ""
    };
  }
  return null;
}

function appendAgentTaskRunConsoleLink(content: string, runConsoleUrl: string | null | undefined) {
  if (!runConsoleUrl) return content;
  return [content, "", `Run console: ${runConsoleUrl}`].join("\n");
}

function formatLastCommandFailure(events: SandboxCommandEvent[] | undefined) {
  const event = events?.find((candidate) => candidate.exitCode !== 0) ?? events?.[0];
  if (!event) return "";
  const tail = event.errorTail || event.outputTail;
  const detail = tail ? `\n${truncateForDiscord(tail.trim(), 900)}` : "";
  const exit = event.exitCode == null ? "" : ` exit=${event.exitCode}`;
  const duration = event.durationMs == null ? "" : ` ${event.durationMs}ms`;
  return `Last sandbox command: \`${event.command ?? event.step}\`${exit}${duration}${detail}`;
}

function formatAgentTaskTimingSummary(events: TaskEvent[] | undefined) {
  if (!events?.length) return "";
  const terminalMetadata = events.find((event) => event.eventName === "task.completed")?.metadata;
  const timings = recordFromUnknown(terminalMetadata?.timingsMs) ?? timingsFromProgressEvents(events);
  const cache = recordFromUnknown(terminalMetadata?.cache) ?? cacheFromProgressEvents(events);
  const timingLine = formatCompactTimingLine(timings);
  const cacheLine = formatCompactCacheLine(cache);
  return [timingLine, cacheLine].filter(Boolean).join("\n");
}

function timingsFromProgressEvents(events: TaskEvent[]) {
  const timings: Record<string, number> = {};
  for (const event of events) {
    const step = stringFromUnknown(event.metadata.step);
    const durationMs = numberFromUnknown(event.metadata.durationMs);
    if (!step || durationMs == null || !step.endsWith("_complete")) continue;
    timings[step.replace(/_complete$/, "")] = durationMs;
  }
  return Object.keys(timings).length ? timings : undefined;
}

function cacheFromProgressEvents(events: TaskEvent[]) {
  const cache: Record<string, unknown> = {};
  for (const event of events.slice().reverse()) {
    const cacheType = stringFromUnknown(event.metadata.cacheType);
    const cacheStatus = stringFromUnknown(event.metadata.cacheStatus);
    if (cacheType === "repo" && cacheStatus) cache.repo = cacheStatus;
    if (cacheType === "dependencies" && cacheStatus) {
      cache.dependencies = cacheStatus;
      cache.dependencyCacheKey = stringFromUnknown(event.metadata.lockHash);
      if (event.metadata.reason === "dependency_files_changed_after_codex") cache.dependencyRefreshAfterCodex = true;
    }
    const taskCache = recordFromUnknown(event.metadata.cache);
    if (taskCache) Object.assign(cache, taskCache);
  }
  return Object.keys(cache).length ? cache : undefined;
}

function formatCompactTimingLine(timings: Record<string, unknown> | undefined) {
  if (!timings) return "";
  const parts = [
    ["total", timings.total],
    ["startup", timings.sandboxStartup],
    ["repo", timings.repo],
    ["deps", timings.dependencies],
    ["deps2", timings.dependenciesPostCodex],
    ["codex", timings.codex],
    ["scan", timings.scan],
    ["push", timings.push],
    ["PR", timings.pr]
  ]
    .map(([label, value]) => {
      const ms = numberFromUnknown(value);
      return ms == null ? null : `${label}=${formatDurationMs(ms)}`;
    })
    .filter(Boolean);
  return parts.length ? `Timings: ${parts.join(" | ")}` : "";
}

function formatCompactCacheLine(cache: Record<string, unknown> | undefined) {
  if (!cache) return "";
  const repo = stringFromUnknown(cache.repo);
  const dependencies = stringFromUnknown(cache.dependencies);
  const dependencyRefresh = cache.dependencyRefreshAfterCodex ? " | refreshed deps after Codex" : "";
  const key = stringFromUnknown(cache.dependencyCacheKey);
  const keySuffix = key ? ` ${key.slice(0, 18)}` : "";
  const parts = [repo ? `repo=${repo}` : "", dependencies ? `deps=${dependencies}${keySuffix}` : ""].filter(Boolean);
  return parts.length ? `Cache: ${parts.join(" | ")}${dependencyRefresh}` : "";
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatDurationMs(ms: number) {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = rounded / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatDurationSeconds(seconds: number) {
  const total = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}
