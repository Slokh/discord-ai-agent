import type { Client, Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentTaskRecord, DiscordAiAgentRepository, SandboxCommandEvent, TaskEvent } from "../db/repositories.js";
import { formatAgentTaskResult, cleanResponse } from "../tools/coreTools.js";
import { durationMs, logger } from "../util/logger.js";
import { runWithTrace } from "../util/trace.js";

const DEFAULT_POLL_MS = 2_000;
const RENDER_LIMIT = 20;
const NONTERMINAL_RENDER_THROTTLE_MS = 5_000;

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
      const rendered = renderAgentTaskMessage(task, undefined, undefined, { runConsoleUrl });
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
        const edited = await message.edit(content);
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
    : progressAgentTaskMessage(task);
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

function progressAgentTaskMessage(task: AgentTaskRecord) {
  const rawDetail = task.statusMessage?.trim();
  const detail =
    task.status === "queued" || !rawDetail
      ? task.status === "running"
        ? "Working on it..."
        : "Working on it..."
      : rawDetail;
  return [detail, "", `Task: \`${task.title}\``, `Status: \`${task.status}\``, `Task ID: \`${task.taskId}\``].join("\n");
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
    repo.getTaskEvents({
      guildId: task.guildId ?? "",
      visibleChannelIds: task.channelId ? [task.channelId] : [],
      traceId: task.taskId,
      limit: 30
    }),
    repo.getSandboxCommandEvents({
      guildId: task.guildId ?? "",
      visibleChannelIds: task.channelId ? [task.channelId] : undefined,
      taskId: task.taskId,
      limit: 8
    })
  ]);
  return [taskEvents, commandEvents];
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
