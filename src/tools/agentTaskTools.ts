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

export async function createAgentUpdateFromRequest(ctx: ToolContext, request: string, title?: string | null): Promise<string> {
  const updateName = agentUpdateTitleFromRequest(request, title);

  const requestedBy = `${ctx.userDisplayName} (${ctx.userId})`;
  const result = await enqueueAgentCodeUpdateTask(ctx, { request, updateName, requestedBy });
  const runConsoleUrl = agentTaskRunConsoleUrl(ctx.config, result.taskId);
  const response = formatAgentTaskResult({ ...result, runConsoleUrl });
  await ctx.updateStatus?.(response);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "runCodingAgent",
    argumentsSummary: summarizeForAudit({ request, updateName }),
    resultSummary: summarizeForAudit(agentTaskAuditSummary(result))
  });

  return response;
}

async function enqueueAgentCodeUpdateTask(
  ctx: ToolContext,
  input: { request: string; updateName: string; requestedBy: string; retriedFromTaskId?: string | null }
): Promise<{ taskId: string; jobId: string | null; job?: AgentTaskRecord }> {
  if (!ctx.jobs) {
    throw new Error("Agent task queue is unavailable in this process.");
  }
  await ctx.updateStatus?.("Working on it...\n\nI’ll edit this message with progress and the PR link when it’s ready.");
  return ctx.jobs.enqueueAgentTask({
    request: input.request.trim(),
    title: input.updateName,
    requestedBy: input.requestedBy,
    taskType: "code_update",
    threadKey: ctx.threadKey,
    discordResponseChannelId: ctx.statusChannelId ?? ctx.channelId,
    discordResponseMessageId: ctx.statusMessageId,
    retriedFromTaskId: input.retriedFromTaskId ?? undefined
  });
}

export async function getAgentTaskStatus(ctx: ToolContext, input: { taskId?: string; limit?: number } = {}): Promise<string> {
  const task = await resolveVisibleAgentTask(ctx, input.taskId, {
    statuses: undefined,
    limit: 1
  });
  if (!task) return input.taskId ? `No visible agent task matched \`${input.taskId}\`.` : "No recent agent task matched this channel.";

  const limit = clampInteger(input.limit, 1, 20, 8);
  const [events, commandEvents] = await Promise.all([
    ctx.repo.getTaskEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId: task.taskId,
      limit
    }),
    ctx.repo.getSandboxCommandEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      taskId: task.taskId,
      limit
    })
  ]);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getAgentTaskStatus",
    argumentsSummary: summarizeForAudit({ taskId: input.taskId, limit }),
    resultSummary: summarizeForAudit({ taskId: task.taskId, status: task.status, events: events.length, commandEvents: commandEvents.length })
  });

  return [
    "Agent task status:",
    formatAgentTaskLine(task),
    task.request ? `Request: ${truncateForDiscord(task.request, 800)}` : "",
    task.error ? `Error: ${truncateForDiscord(task.error, 800)}` : "",
    task.prUrl ? `PR: ${task.prUrl}` : "",
    "",
    formatTaskEvents(events),
    "",
    formatSandboxCommandEvents(commandEvents)
  ]
    .filter((line) => line !== "")
    .join("\n");
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
