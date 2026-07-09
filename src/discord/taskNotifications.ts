import type { Client, Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentTaskRecord, DiscordAiAgentRepository, SandboxCommandEvent, TaskEvent } from "../db/repositories.js";
import { formatAgentTaskResult } from "../tools/coreTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import { durationMs, logger } from "../util/logger.js";
import { runWithTrace } from "../util/trace.js";
import { discordEdit } from "./api.js";

const DEFAULT_POLL_MS = 2_000;
const RENDER_LIMIT = 20;
const NONTERMINAL_RENDER_THROTTLE_MS = 2_000;

export type AgentTaskNotifierRuntime = {
  stop: () => void;
};

export function startAgentTaskNotifier(input: {
  client: Client;
  repo: DiscordAiAgentRepository;
  config: AppConfig;
  pollMs?: number;
}): AgentTaskNotifierRuntime {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = Date.now();
    try {
      const tasks = await input.repo.listRenderableAgentTasks(RENDER_LIMIT);
      if (tasks.length > 0) {
        logger.debug({ taskCount: tasks.length }, "Rendering agent task Discord updates");
      }
      for (const task of tasks) {
        await renderTask(input, task).catch((error) => {
          logger.warn({ err: error, taskId: task.taskId }, "Failed to render agent task Discord update");
        });
      }
    } catch (error) {
      logger.warn({ err: error, durationMs: durationMs(startedAt) }, "Agent task notifier poll failed");
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
    }
  };

  timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
  logger.info({ pollMs: input.pollMs ?? DEFAULT_POLL_MS }, "Started agent task Discord renderer");

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

async function renderTask(input: { client: Client; repo: DiscordAiAgentRepository; config: AppConfig }, task: AgentTaskRecord) {
  await runWithTrace(
    {
      traceId: task.traceId ?? task.taskId,
      requestId: task.taskId,
      guildId: task.guildId ?? undefined,
      channelId: task.channelId ?? undefined,
      userId: task.userId ?? undefined,
      messageId: task.taskId
    },
    async () => {
      const runConsoleUrl = agentTaskRunConsoleUrl(input.config, task.taskId);
      const terminal = isTerminalAgentTaskStatus(task.status);
      const progressEvents = terminal ? undefined : await recentTaskEvents(input.repo, task);
      const rendered = renderAgentTaskMessage(task, progressEvents, undefined, { runConsoleUrl });
      if (!shouldRenderAgentTask(task, rendered)) {
        if (!rendered.terminal && task.lastRenderedSignature === rendered.signature) {
          await input.repo.markAgentTaskRendered({ taskId: task.taskId, signature: rendered.signature, terminal: false });
        }
        return;
      }

      const startedAt = Date.now();
      try {
        const message = await fetchTaskReply(input.client, task);
        const renderedWithDetails = rendered.terminal
          ? renderAgentTaskMessage(task, ...(await taskDetails(input.repo, task)), { runConsoleUrl })
          : rendered;
        const content = cleanResponse(renderedWithDetails.content, input.config.maxReplyChars);
        const editedResult = await discordEdit(message, content, { logger });
        if (!editedResult.ok) throw editedResult.error;
        const edited = editedResult.value;
        await input.repo.markAgentTaskRendered({
          taskId: task.taskId,
          signature: renderedWithDetails.signature,
          terminal: renderedWithDetails.terminal
        });
        if (renderedWithDetails.terminal && task.threadKey) {
          await input.repo.appendConversationMessage({
            threadKey: task.threadKey,
            role: "assistant",
            discordMessageId: edited.id,
            authorId: input.client.user?.id ?? null,
            authorDisplayName: input.client.user?.username ?? null,
            content,
            metadata: {
              discordUrl: edited.url,
              agentTask: true,
              taskId: task.taskId,
              status: task.status,
              prUrl: task.prUrl,
              draft: task.draft,
              verifyPassed: task.verifyPassed
            }
          });
        }
        logger.info(
          {
            taskId: task.taskId,
            status: task.status,
            terminal: renderedWithDetails.terminal,
            replyMessageId: task.discordResponseMessageId,
            durationMs: durationMs(startedAt)
          },
          "Rendered agent task Discord update"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await input.repo.markAgentTaskNotificationFailed({ taskId: task.taskId, error: message });
        throw error;
      }
    }
  );
}

export function renderAgentTaskMessage(
  task: AgentTaskRecord,
  taskEvents?: TaskEvent[],
  commandEvents?: SandboxCommandEvent[],
  options: { runConsoleUrl?: string | null } = {}
): { content: string; signature: string; terminal: boolean } {
  const terminal = isTerminalAgentTaskStatus(task.status);
  const baseContent = terminal
    ? formatAgentTaskResult({ taskId: task.taskId, jobId: task.pgBossJobId, job: task, taskEvents, commandEvents })
    : progressAgentTaskMessage(task, taskEvents);
  const content = appendRunConsoleLink(baseContent, options.runConsoleUrl);
  return {
    content,
    terminal,
    signature: JSON.stringify({
      status: task.status,
      currentStep: task.currentStep,
      statusMessage: task.statusMessage,
      branchName: task.branchName,
      prUrl: task.prUrl,
      draft: task.draft,
      verifyPassed: task.verifyPassed,
      error: task.error,
      runConsoleUrl: options.runConsoleUrl,
      progressEvents: terminal ? undefined : taskEvents?.map((event) => [event.id, event.summary, event.metadata?.step]),
      terminalDetails: terminal ? content : undefined
    })
  };
}

function shouldRenderAgentTask(task: AgentTaskRecord, rendered: { signature: string; terminal: boolean }) {
  if (!task.discordResponseChannelId || !task.discordResponseMessageId) return false;
  if (rendered.terminal) return true;
  if (task.lastRenderedSignature === rendered.signature) return false;
  if (!task.lastRenderedAt) return true;
  return Date.now() - task.lastRenderedAt.getTime() >= NONTERMINAL_RENDER_THROTTLE_MS;
}

function progressAgentTaskMessage(task: AgentTaskRecord, taskEvents: TaskEvent[] | undefined) {
  const rawDetail = task.statusMessage?.trim();
  const title = task.title.trim() || "code update";
  const heading = task.status === "queued" ? `Queued \`${title}\`.` : `Working on \`${title}\`.`;
  const latest = rawDetail || (task.status === "queued" ? "Waiting for a sandbox to start." : "Starting the coding agent.");
  const step = task.currentStep ? humanizeTaskStep(task.currentStep) : null;
  const timing = progressTimingLine(task);
  const activity = progressActivityLines(taskEvents, task);
  return [
    heading,
    latest,
    step ? `Current phase: ${step}` : "",
    timing,
    activity.length ? "Recent activity:" : "",
    ...activity,
    `Task ID: \`${task.taskId}\``
  ]
    .filter(Boolean)
    .join("\n");
}

function progressTimingLine(task: AgentTaskRecord) {
  const startedAt = task.startedAt ?? task.createdAt;
  const pieces = [`Started ${discordRelativeTime(startedAt)}`];
  if (task.progressUpdatedAt) pieces.push(`last progress ${discordRelativeTime(task.progressUpdatedAt)}`);
  return pieces.join(" · ");
}

function progressActivityLines(taskEvents: TaskEvent[] | undefined, task: AgentTaskRecord) {
  const seen = new Set<string>();
  const latestStatus = task.statusMessage?.trim();
  const currentStep = task.currentStep ? humanizeTaskStep(task.currentStep) : null;
  const events = [...(taskEvents ?? [])]
    .filter((event) => event.summary?.trim())
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id - left.id);
  const lines: string[] = [];
  for (const event of events) {
    const summary = event.summary!.trim();
    const step = typeof event.metadata?.step === "string" ? humanizeTaskStep(event.metadata.step) : null;
    const key = `${step ?? ""}:${summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (latestStatus && currentStep && step === currentStep && summary === latestStatus) continue;
    const label = step ? `${step}: ${summary}` : summary;
    lines.push(`- ${discordShortTime(event.createdAt)} ${truncateProgressLine(label)}`);
    if (lines.length >= 3) break;
  }
  return lines.reverse();
}

function truncateProgressLine(value: string) {
  return value.length <= 140 ? value : `${value.slice(0, 137)}...`;
}

function discordRelativeTime(date: Date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function discordShortTime(date: Date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:T>`;
}

function humanizeTaskStep(step: string) {
  const labels: Record<string, string> = {
    sandbox_acquired: "sandbox started",
    repo: "preparing repository",
    repo_complete: "repository ready",
    dependencies: "preparing dependencies",
    dependencies_complete: "dependencies ready",
    toolShims: "installing helper tools",
    toolShims_complete: "helper tools ready",
    context: "building code context",
    context_complete: "code context ready",
    opencode_server_start: "starting OpenCode",
    opencode_server_ready: "OpenCode ready",
    opencode_round_started: "model round started",
    opencode_round_finished: "model round finished",
    opencode_first_edit: "first edit made",
    diff: "checking for code changes",
    scan: "running release scan",
    scan_complete: "release scan passed",
    commit: "committing changes",
    push: "pushing branch",
    push_complete: "branch pushed",
    pr: "opening pull request",
    pr_complete: "pull request opened",
    task_complete: "task complete",
    cleanup: "cleaning up"
  };
  return labels[step] ?? step.replace(/_/g, " ");
}

export function agentTaskRunConsoleUrl(config: AppConfig, taskId: string) {
  if (!config.controlUi.publicUrl) return null;
  return `${config.controlUi.publicUrl}/runs/${encodeURIComponent(taskId)}`;
}

function appendRunConsoleLink(content: string, runConsoleUrl: string | null | undefined) {
  if (!runConsoleUrl) return content;
  return [content, "", `Run console: ${runConsoleUrl}`].join("\n");
}

function isTerminalAgentTaskStatus(status: AgentTaskRecord["status"]) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}

async function taskDetails(
  repo: DiscordAiAgentRepository,
  task: AgentTaskRecord
): Promise<[TaskEvent[] | undefined, SandboxCommandEvent[] | undefined]> {
  const [taskEvents, commandEvents] = await Promise.all([
    recentTaskEvents(repo, task, 30),
    repo.getSandboxCommandEvents({
      guildId: task.guildId ?? "",
      visibleChannelIds: task.channelId ? [task.channelId] : undefined,
      taskId: task.taskId,
      limit: 8
    })
  ]);
  return [taskEvents, commandEvents];
}

async function recentTaskEvents(repo: DiscordAiAgentRepository, task: AgentTaskRecord, limit = 8): Promise<TaskEvent[] | undefined> {
  return repo.getTaskProgressEventsForTask({ taskId: task.taskId, limit }).catch((error) => {
    logger.warn({ err: error, taskId: task.taskId }, "Failed to load recent agent task progress events for Discord progress render");
    return undefined;
  });
}

async function fetchTaskReply(client: Client, task: AgentTaskRecord): Promise<Message> {
  if (!task.discordResponseChannelId || !task.discordResponseMessageId) {
    throw new Error("Agent task is missing Discord reply target.");
  }
  const channel = await client.channels.fetch(task.discordResponseChannelId);
  const messages = (channel as any)?.messages;
  if (!messages?.fetch) {
    throw new Error(`Discord channel ${task.discordResponseChannelId} does not support message fetch.`);
  }
  return (await messages.fetch(task.discordResponseMessageId)) as Message;
}
