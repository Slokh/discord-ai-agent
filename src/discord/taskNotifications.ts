import type { Client } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { formatAgentTaskResult, cleanResponse } from "../tools/coreTools.js";
import { logger } from "../util/logger.js";

const DEFAULT_POLL_MS = 5_000;

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
    try {
      const tasks = await input.repo.listTerminalAgentTasksNeedingNotification(20);
      for (const task of tasks) {
        await notifyTask(input, task.taskId).catch((error) => {
          logger.warn({ err: error, taskId: task.taskId }, "Failed to notify completed agent task");
        });
      }
    } catch (error) {
      logger.warn({ err: error }, "Agent task notifier poll failed");
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
    }
  };

  timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
  logger.info({ pollMs: input.pollMs ?? DEFAULT_POLL_MS }, "Started agent task completion notifier");

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

async function notifyTask(input: { client: Client; repo: DiscordAiAgentRepository; config: AppConfig }, taskId: string) {
  const task = await input.repo.getAgentTask(taskId);
  if (!task?.discordResponseChannelId || !task.discordResponseMessageId) return;

  try {
    const channel = await input.client.channels.fetch(task.discordResponseChannelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Channel ${task.discordResponseChannelId} does not support message edits.`);
    }
    const messages = channel.messages;
    const [message, taskEvents, commandEvents] = await Promise.all([
      messages.fetch(task.discordResponseMessageId),
      input.repo.getTaskEvents({
        guildId: task.guildId ?? "",
        visibleChannelIds: task.channelId ? [task.channelId] : [],
        traceId: task.taskId,
        limit: 30
      }),
      input.repo.getSandboxCommandEvents({
        guildId: task.guildId ?? "",
        visibleChannelIds: task.channelId ? [task.channelId] : undefined,
        taskId: task.taskId,
        limit: 8
      })
    ]);
    await message.edit(
      cleanResponse(
        formatAgentTaskResult({ taskId: task.taskId, jobId: task.pgBossJobId, job: task, taskEvents, commandEvents }),
        input.config.maxReplyChars
      )
    );
    await input.repo.markAgentTaskNotified(task.taskId);
    logger.info({ taskId: task.taskId, replyMessageId: task.discordResponseMessageId }, "Notified Discord of completed agent task");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.repo.markAgentTaskNotificationFailed({ taskId: task.taskId, error: message });
    throw error;
  }
}
