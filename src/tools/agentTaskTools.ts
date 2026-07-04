import { enqueueAgentRuntimeCodeUpdateTask } from "../agent/runtimeControlPlane.js";
import { resolveGitHubTaskToken } from "../github/appToken.js";
import { parseGitHubRepository } from "../github/repository.js";
import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { AgentTaskRecord, AgentTaskStatus, SandboxCommandEvent, TaskEvent } from "../db/repositories.js";
import type { ToolContext } from "./types.js";
import {
  agentTaskAuditSummary,
  agentTaskRunConsoleUrl,
  agentUpdateTitleFromRequest,
  formatActiveAgentTaskLine,
  formatAgentTaskLine,
  formatAgentTaskResult,
  formatDurationMs,
  formatDurationSeconds
} from "./agentTaskFormatting.js";

const ACTIVE_AGENT_TASK_STATUSES: AgentTaskStatus[] = ["queued", "running"];
const GITHUB_API_BASE_URL = "https://api.github.com";

export type AgentUpdateTarget = {
  targetBranch?: string | null;
  targetPullRequestNumber?: number | null;
  targetPullRequestUrl?: string | null;
};

export async function createAgentUpdateFromRequest(
  ctx: ToolContext,
  request: string,
  title?: string | null,
  target: AgentUpdateTarget = {}
): Promise<string> {
  const updateName = agentUpdateTitleFromRequest(request, title);

  const requestedBy = `${ctx.userDisplayName} (${ctx.userId})`;
  const result = await enqueueAgentCodeUpdateTask(ctx, { request, updateName, requestedBy, ...target });
  const runConsoleUrl = agentTaskRunConsoleUrl(ctx.config, result.taskId);
  const response = formatAgentTaskResult({ ...result, runConsoleUrl });
  await ctx.updateStatus?.(response);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "runCodingAgent",
    argumentsSummary: summarizeForAudit({ request, updateName, ...target }),
    resultSummary: summarizeForAudit(agentTaskAuditSummary(result))
  });

  return response;
}

async function enqueueAgentCodeUpdateTask(
  ctx: ToolContext,
  input: {
    request: string;
    updateName: string;
    requestedBy: string;
    retriedFromTaskId?: string | null;
    targetBranch?: string | null;
    targetPullRequestNumber?: number | null;
    targetPullRequestUrl?: string | null;
  }
): Promise<{ taskId: string; jobId: string | null; job?: AgentTaskRecord }> {
  if (!ctx.jobs) {
    throw new Error("Agent task queue is unavailable in this process.");
  }
  await ctx.updateStatus?.("Working on it...\n\nI’ll edit this message with progress and the PR link when it’s ready.");
  if (ctx.agentRuntime && ctx.agentRuntimeSession) {
    return enqueueAgentRuntimeCodeUpdateTask({
      config: ctx.config,
      repo: ctx.repo,
      agentRuntime: ctx.agentRuntime,
      jobs: ctx.jobs,
      session: ctx.agentRuntimeSession,
      traceId: ctx.requestId,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      threadKey: ctx.threadKey,
      parentExecutionId: ctx.agentRuntimeExecutionId,
      request: input.request.trim(),
      title: input.updateName,
      requestedBy: input.requestedBy,
      discordResponseChannelId: ctx.statusChannelId ?? ctx.channelId,
      discordResponseMessageId: ctx.statusMessageId,
      retriedFromTaskId: input.retriedFromTaskId ?? undefined,
      targetBranch: nonEmptyString(input.targetBranch),
      targetPullRequestNumber: finitePositiveInteger(input.targetPullRequestNumber),
      targetPullRequestUrl: nonEmptyString(input.targetPullRequestUrl)
    });
  }
  return ctx.jobs.enqueueAgentTask({
    traceId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    request: input.request.trim(),
    title: input.updateName,
    requestedBy: input.requestedBy,
    taskType: "code_update",
    threadKey: ctx.threadKey,
    discordResponseChannelId: ctx.statusChannelId ?? ctx.channelId,
    discordResponseMessageId: ctx.statusMessageId,
    retriedFromTaskId: input.retriedFromTaskId ?? undefined,
    targetBranch: nonEmptyString(input.targetBranch),
    targetPullRequestNumber: finitePositiveInteger(input.targetPullRequestNumber),
    targetPullRequestUrl: nonEmptyString(input.targetPullRequestUrl)
  });
}

export async function getAgentTaskStatus(ctx: ToolContext, input: { taskId?: string; limit?: number } = {}): Promise<string> {
  const task = await resolveVisibleAgentTask(ctx, input.taskId, {
    statuses: undefined,
    limit: 1
  });
  if (!task) return input.taskId ? `No visible agent task matched \`${input.taskId}\`.` : "No recent agent task matched this channel.";

  const limit = clampInteger(input.limit, 1, 20, 8);
  const [events, commandEvents, pullRequestStatus] = await Promise.all([
    getTaskStatusEvents(ctx, task, limit),
    ctx.repo.getSandboxCommandEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      taskId: task.taskId,
      limit
    }),
    getTaskPullRequestStatus(ctx, task)
  ]);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getAgentTaskStatus",
    argumentsSummary: summarizeForAudit({ taskId: input.taskId, limit }),
    resultSummary: summarizeForAudit({
      taskId: task.taskId,
      status: task.status,
      events: events.length,
      commandEvents: commandEvents.length,
      pullRequestStatus: Boolean(pullRequestStatus)
    })
  });

  return [
    "Agent task status:",
    formatAgentTaskLine(task),
    task.request ? `Request: ${truncateForDiscord(task.request, 800)}` : "",
    task.error ? `Error: ${truncateForDiscord(task.error, 800)}` : "",
    task.prUrl ? `PR: ${task.prUrl}` : "",
    pullRequestStatus,
    "",
    formatTaskEvents(events),
    "",
    formatSandboxCommandEvents(commandEvents)
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function getTaskStatusEvents(ctx: ToolContext, task: AgentTaskRecord, limit: number): Promise<TaskEvent[]> {
  return ctx.repo.getTaskProgressEventsForTask({ taskId: task.taskId, limit });
}

async function getTaskPullRequestStatus(ctx: ToolContext, task: AgentTaskRecord): Promise<string> {
  if (!task.prUrl) return "";
  const githubConfig = ctx.config.github;
  if (!githubConfig?.repository) return "GitHub PR status: unavailable; GITHUB_REPOSITORY is not configured.";

  const parsedPullRequest = parsePullRequestUrl(task.prUrl);
  if (!parsedPullRequest) return "GitHub PR status: unavailable; could not parse the PR URL.";

  try {
    const configuredRepo = parseGitHubRepository(githubConfig.repository);
    const owner = parsedPullRequest.owner || configuredRepo.owner;
    const repo = parsedPullRequest.repo || configuredRepo.repo;
    const token = await resolveGitHubTaskToken(ctx.config);
    const pullRequest = await githubJson<GitHubPullRequestResponse>(`/repos/${owner}/${repo}/pulls/${parsedPullRequest.pullNumber}`, token);
    const headSha = pullRequest.head?.sha;
    const [checks, status] = headSha
      ? await Promise.all([
          githubJson<GitHubCheckRunsResponse>(`/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=50`, token).catch((error) => ({
            error
          })),
          githubJson<GitHubCombinedStatusResponse>(`/repos/${owner}/${repo}/commits/${headSha}/status`, token).catch((error) => ({ error }))
        ])
      : [undefined, undefined];
    return formatGitHubPullRequestStatus({
      pullRequest,
      checks: isGitHubCheckRunsResponse(checks) ? checks : undefined,
      checksError: errorMessageFromMaybeError(checks),
      status: isGitHubCombinedStatusResponse(status) ? status : undefined,
      statusError: errorMessageFromMaybeError(status)
    });
  } catch (error) {
    return `GitHub PR status: unavailable; ${truncateForDiscord(error instanceof Error ? error.message : String(error), 240)}`;
  }
}

type GitHubPullRequestResponse = {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  html_url?: string;
  head?: {
    ref?: string;
    sha?: string;
  };
};

type GitHubCheckRun = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  output?: {
    title?: string | null;
    summary?: string | null;
  } | null;
};

type GitHubCheckRunsResponse = {
  total_count?: number;
  check_runs?: GitHubCheckRun[];
};

type GitHubCommitStatus = {
  context?: string;
  state?: string;
  target_url?: string | null;
  description?: string | null;
};

type GitHubCombinedStatusResponse = {
  state?: string;
  statuses?: GitHubCommitStatus[];
};

function parsePullRequestUrl(prUrl: string) {
  try {
    const url = new URL(prUrl);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return undefined;
    return {
      owner: match[1],
      repo: match[2],
      pullNumber: Number(match[3])
    };
  } catch {
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    if (!match) return undefined;
    return {
      owner: match[1],
      repo: match[2],
      pullNumber: Number(match[3])
    };
  }
}

async function githubJson<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}${body ? `: ${truncateForDiscord(body, 180)}` : ""}`);
  }
  return (await response.json()) as T;
}

function formatGitHubPullRequestStatus(input: {
  pullRequest: GitHubPullRequestResponse;
  checks?: GitHubCheckRunsResponse;
  checksError?: string;
  status?: GitHubCombinedStatusResponse;
  statusError?: string;
}) {
  const pr = input.pullRequest;
  const head = pr.head?.sha ? ` head=${pr.head.sha.slice(0, 7)}` : "";
  const branch = pr.head?.ref ? ` branch=${pr.head.ref}` : "";
  const lines = [
    "GitHub PR status:",
    `- PR #${pr.number ?? "?"}: ${pr.state ?? "unknown"}${pr.draft ? ", draft" : ""}${head}${branch}${pr.title ? ` - ${truncateForDiscord(pr.title, 120)}` : ""}`
  ];

  if (input.checks) {
    lines.push(formatCheckRuns(input.checks));
  } else if (input.checksError) {
    lines.push(`- Checks: unavailable; ${truncateForDiscord(input.checksError, 180)}`);
  }

  if (input.status) {
    lines.push(formatCombinedStatus(input.status));
  } else if (input.statusError) {
    lines.push(`- Commit status: unavailable; ${truncateForDiscord(input.statusError, 180)}`);
  }

  return lines.filter(Boolean).join("\n");
}

function formatCheckRuns(checks: GitHubCheckRunsResponse) {
  const checkRuns = checks.check_runs ?? [];
  if (checkRuns.length === 0) return "- Checks: none reported yet.";
  const counts = countBy(checkRuns.map(checkRunState));
  const failing = checkRuns.filter((check) => ["failure", "timed_out", "cancelled", "action_required"].includes(checkRunState(check)));
  const pending = checkRuns.filter((check) => ["queued", "in_progress", "waiting", "requested", "pending"].includes(checkRunState(check)));
  const lines = [`- Checks: ${formatCounts(counts)}`];
  if (failing.length > 0) {
    lines.push("- Failing checks:");
    lines.push(...failing.slice(0, 8).map((check) => `  - ${formatCheckRunLine(check)}`));
    lines.push("- Next action: for debugging or fixing, call runCodingAgent so the sandbox can inspect logs with gh CLI and run focused local checks.");
  }
  if (pending.length > 0) {
    lines.push("- Pending checks:");
    lines.push(...pending.slice(0, 5).map((check) => `  - ${formatCheckRunLine(check)}`));
  }
  return lines.join("\n");
}

function formatCombinedStatus(status: GitHubCombinedStatusResponse) {
  const statuses = status.statuses ?? [];
  if (statuses.length === 0) return `- Commit status: ${status.state ?? "none reported"}.`;
  const failing = statuses.filter((entry) => entry.state && entry.state !== "success");
  const lines = [`- Commit status: ${status.state ?? "unknown"} (${formatCounts(countBy(statuses.map((entry) => entry.state ?? "unknown")))})`];
  if (failing.length > 0) {
    lines.push("- Non-success commit statuses:");
    lines.push(...failing.slice(0, 8).map((entry) => `  - ${entry.context ?? "status"} (${entry.state ?? "unknown"})${entry.target_url ? ` ${entry.target_url}` : ""}`));
  }
  return lines.join("\n");
}

function formatCheckRunLine(check: GitHubCheckRun) {
  const state = checkRunState(check);
  const summary = check.output?.title || check.output?.summary || "";
  return truncateForDiscord(`${check.name ?? "check"} (${state})${check.html_url ? ` ${check.html_url}` : ""}${summary ? ` - ${summary}` : ""}`, 300);
}

function checkRunState(check: GitHubCheckRun) {
  return check.conclusion || check.status || "unknown";
}

function countBy(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatCounts(counts: Map<string, number>) {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}

function isGitHubCheckRunsResponse(value: unknown): value is GitHubCheckRunsResponse {
  return Boolean(value && typeof value === "object" && "check_runs" in value);
}

function isGitHubCombinedStatusResponse(value: unknown): value is GitHubCombinedStatusResponse {
  return Boolean(value && typeof value === "object" && "statuses" in value);
}

function errorMessageFromMaybeError(value: unknown) {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  const error = (value as { error?: unknown }).error;
  return error instanceof Error ? error.message : String(error);
}

export async function listAgentTasks(ctx: ToolContext, input: { statuses?: string[]; limit?: number } = {}): Promise<string> {
  const statuses = normalizeAgentTaskStatuses(input.statuses);
  const limit = clampInteger(input.limit, 1, 20, 10);
  const tasks = await ctx.repo.listAgentTasks({
    guildId: ctx.guildId,
    visibleChannelIds: ctx.visibleChannelIds,
    statuses,
    limit
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "listAgentTasks",
    argumentsSummary: summarizeForAudit({ statuses, limit }),
    resultSummary: summarizeForAudit({ tasks: tasks.length })
  });

  if (tasks.length === 0) return "No visible agent tasks matched.";
  return ["Recent agent tasks:", ...tasks.map(formatAgentTaskLine)].join("\n");
}

export async function retryAgentTask(ctx: ToolContext, input: { taskId?: string } = {}): Promise<string> {
  const task = await resolveVisibleAgentTask(ctx, input.taskId, {
    statuses: ["failed", "no_changes", "cancelled"],
    limit: 1
  });
  if (!task) return input.taskId ? `No retryable visible agent task matched \`${input.taskId}\`.` : "No recent failed, no-change, or cancelled agent task matched.";

  const requestedBy = `${ctx.userDisplayName} (${ctx.userId}) retrying ${task.taskId}`;
  const result = await enqueueAgentCodeUpdateTask(ctx, {
    request: task.request,
    updateName: task.title,
    requestedBy,
    retriedFromTaskId: task.taskId
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "retryAgentTask",
    argumentsSummary: summarizeForAudit({ taskId: task.taskId }),
    resultSummary: summarizeForAudit(agentTaskAuditSummary(result))
  });

  return formatAgentTaskResult(result);
}

export async function cancelAgentTask(ctx: ToolContext, input: { taskId?: string; reason?: string } = {}): Promise<string> {
  const task = await resolveVisibleAgentTask(ctx, input.taskId, {
    statuses: ["queued", "running"],
    limit: 1
  });
  if (!task) return input.taskId ? `No active visible agent task matched \`${input.taskId}\`.` : "No active agent task matched.";

  const cancelled = await ctx.repo.cancelAgentTask({
    taskId: task.taskId,
    reason: input.reason ?? `Cancelled by ${ctx.userDisplayName} (${ctx.userId}).`
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "cancelAgentTask",
    argumentsSummary: summarizeForAudit({ taskId: task.taskId, reason: input.reason }),
    resultSummary: summarizeForAudit({ cancelled })
  });

  if (!cancelled) return `Task \`${task.taskId}\` was not cancelled, likely because it already finished.`;
  return `Cancelled agent task \`${task.taskId}\`. The sandbox cleanup reconciler will remove any remaining Kubernetes resources.`;
}

export async function getDeploymentStatus(ctx: ToolContext): Promise<string> {
  const [health, taskMetrics, activeTasks, recentTasks] = await Promise.all([
    ctx.repo.health(),
    ctx.repo.getAgentTaskMetrics(),
    ctx.repo.listAgentTasks({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      statuses: ACTIVE_AGENT_TASK_STATUSES,
      limit: 5
    }),
    ctx.repo.listAgentTasks({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      limit: 5
    })
  ]);

  const revision =
    process.env.GITHUB_SHA ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.K_REVISION ??
    process.env.HOSTNAME ??
    "unknown";

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getDeploymentStatus",
    argumentsSummary: "deployment status",
    resultSummary: summarizeForAudit({ revision, activeTasks: activeTasks.length, recentTasks: recentTasks.length })
  });

  const nowMs = Date.now();
  return [
    "Deployment status:",
    `- Revision: ${revision}`,
    `- Uptime: ${formatDurationSeconds(process.uptime())}`,
    `- Node: ${process.version}`,
    `- Repository: ${ctx.config.github.repository || "not configured"}`,
    `- Base branch: ${ctx.config.github.baseBranch}`,
    `- Indexed messages: ${health.messages}`,
    `- Embeddings: ${health.embeddings}`,
    `- Tool calls logged: ${health.toolCalls}`,
    `- Agent tasks: ${taskMetrics.tasksByStatus.map((row) => `${row.status}=${row.count}`).join(", ") || "none"}`,
    `- Agent backlog: ${formatAgentTaskBacklogSummary(taskMetrics.agentTaskBacklog)}`,
    `- Codegen leases: ${formatLeaseMetricSummary(taskMetrics.codegenSandboxLeases)}`,
    `- Codegen timings: ${formatCodegenMetricSummary(taskMetrics.codegenPhaseDurations)}`,
    `- Sandbox cache: ${formatCacheMetricSummary(taskMetrics.sandboxCacheEvents)}`,
    activeTasks.length ? "Active code updates:" : "Active code updates: none",
    ...activeTasks.map((task) => `- ${formatActiveAgentTaskLine(task, nowMs)}`),
    recentTasks.length ? "Recent tasks:" : "Recent tasks: none",
    ...recentTasks.map((task) => `- ${formatAgentTaskLine(task)}`)
  ].join("\n");
}

export function formatTaskEvents(events: TaskEvent[]) {
  if (events.length === 0) return "Task events: none.";
  return [
    "Task events:",
    ...events
      .slice()
      .reverse()
      .map((event) => {
        const summary = event.summary ? ` - ${truncateForDiscord(event.summary, 180)}` : "";
        return `- ${event.createdAt.toISOString()} ${event.level} ${event.eventName} task=${event.taskId}${summary}`;
      })
  ].join("\n");
}

export function formatSandboxCommandEvents(events: SandboxCommandEvent[]) {
  if (events.length === 0) return "Sandbox commands: none.";
  return [
    "Sandbox commands:",
    ...events
      .slice()
      .reverse()
      .map((event) => {
        const exit = event.exitCode == null ? "" : ` exit=${event.exitCode}`;
        const duration = event.durationMs == null ? "" : ` ${event.durationMs}ms`;
        const tail = (event.errorTail || event.outputTail).trim();
        return `- ${event.createdAt.toISOString()} ${event.step}${exit}${duration} ${truncateForDiscord(event.command ?? "", 160)}${
          tail ? `\n  ${truncateForDiscord(tail, 300)}` : ""
        }`;
      })
  ].join("\n");
}

async function resolveVisibleAgentTask(
  ctx: ToolContext,
  taskId: string | undefined,
  options: { statuses?: AgentTaskStatus[]; limit: number }
): Promise<AgentTaskRecord | undefined> {
  if (taskId?.trim()) {
    const task = await ctx.repo.getAgentTask(taskId.trim());
    if (!task || !isAgentTaskVisible(ctx, task)) return undefined;
    if (options.statuses?.length && !options.statuses.includes(task.status)) return undefined;
    return task;
  }
  return (
    await ctx.repo.listAgentTasks({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      channelId: ctx.channelId,
      statuses: options.statuses,
      limit: options.limit
    })
  )[0];
}

function isAgentTaskVisible(ctx: ToolContext, task: AgentTaskRecord) {
  return task.guildId === ctx.guildId && (!task.channelId || ctx.visibleChannelIds.includes(task.channelId));
}

function normalizeAgentTaskStatuses(statuses: string[] | undefined): AgentTaskStatus[] | undefined {
  if (!statuses?.length) return undefined;
  const allowed: AgentTaskStatus[] = ["queued", "running", "succeeded", "failed", "no_changes", "cancelled"];
  const normalized = uniqueStrings(statuses.map((status) => status.trim()).filter(Boolean)).filter((status): status is AgentTaskStatus =>
    allowed.includes(status as AgentTaskStatus)
  );
  return normalized.length ? normalized : undefined;
}

function formatCodegenMetricSummary(rows: Array<{ phase: string; count: number; avgMs: number; maxMs: number }>) {
  if (rows.length === 0) return "none yet";
  const preferred = ["repo", "dependencies", "dependenciesPostCodex", "codex", "verify", "scan", "push", "pr", "total"];
  const byPhase = new Map(rows.map((row) => [row.phase, row]));
  return preferred
    .map((phase) => byPhase.get(phase))
    .filter((row): row is { phase: string; count: number; avgMs: number; maxMs: number } => Boolean(row))
    .map((row) => `${row.phase} avg=${formatDurationMs(row.avgMs)} max=${formatDurationMs(row.maxMs)}`)
    .join(", ");
}

function formatCacheMetricSummary(rows: Array<{ cacheType: string; cacheStatus: string; count: number }>) {
  if (rows.length === 0) return "none yet";
  return rows.map((row) => `${row.cacheType}.${row.cacheStatus}=${row.count}`).join(", ");
}

function formatLeaseMetricSummary(rows: Array<{ backend: string; status: string; count: number }>) {
  if (rows.length === 0) return "none yet";
  return rows.map((row) => `${row.backend}.${row.status}=${row.count}`).join(", ");
}

function formatAgentTaskBacklogSummary(rows: Array<{ backend: string; status: string; count: number; oldestAgeSeconds: number }>) {
  if (rows.length === 0) return "none";
  return rows
    .map((row) => `${row.backend}.${row.status}=${row.count} oldest=${formatDurationSeconds(row.oldestAgeSeconds)}`)
    .join(", ");
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  const integer = Math.trunc(value);
  return Math.max(min, Math.min(max, integer));
}

function nonEmptyString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function finitePositiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : undefined;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
