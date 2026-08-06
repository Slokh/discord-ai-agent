import { ChannelType, PermissionFlagsBits, type Client, type Message, type MessageCreateOptions } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository, ScheduledReminder, ScheduleRunStatus } from "../db/repositories.js";
import type { ReminderWakeup } from "../db/reminderRepository.js";
import { sendDiscordNotification } from "../discord/responseSink.js";
import {
  finishBackgroundJobRuntime,
  recordBackgroundJobEvent,
  startBackgroundJobRuntime,
} from "../observability/backgroundJobRuntime.js";
import { durationMs, logger } from "../util/logger.js";
import { nextReminderOccurrence } from "./recurrence.js";
import type { ScheduledAgentRequestRunner } from "./scheduledAgentExecution.js";

export type ReminderDeliveryRunner = {
  deliver: (reminderId: string) => Promise<ReminderWakeup | null>;
  listDueReminderWakeups: () => Promise<ReminderWakeup[]>;
};

export function createReminderDeliveryRunner(input: {
  client: Client;
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  scheduledAgent?: ScheduledAgentRequestRunner;
}): ReminderDeliveryRunner {
  return {
    listDueReminderWakeups: () => input.repo.listDueReminderWakeups(),
    deliver: async (reminderId) => deliverReminder({ ...input, reminderId }),
  };
}

async function deliverReminder(input: {
  client: Client;
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  scheduledAgent?: ScheduledAgentRequestRunner;
  reminderId: string;
}) {
  const reminder = await input.repo.claimReminderForDelivery({ reminderId: input.reminderId });
  if (!reminder) return null;
  const startedAt = Date.now();
  const runtime = await startBackgroundJobRuntime({
    agentRuntime: input.agentRuntime,
    executionId: `reminder-delivery-${reminder.reminderId}-${reminder.occurrenceSequence}-${reminder.deliveryAttempts}`,
    traceId: reminder.reminderId,
    kind: "reminder_delivery",
    title: reminder.deliveryKind === "agent" ? "Scheduled agent request" : "Scheduled reminder delivery",
    request: `Deliver scheduled ${reminder.deliveryKind} ${reminder.reminderId}.`,
    source: "pgboss.reminder",
    guildId: reminder.guildId,
    channelId: reminder.channelId,
    metadata: { reminderId: reminder.reminderId, occurrence: reminder.occurrenceSequence, attempt: reminder.deliveryAttempts, deliveryKind: reminder.deliveryKind },
  }).catch((error) => {
    logger.warn({ err: error, reminderId: reminder.reminderId }, "Failed to create reminder delivery runtime");
    return null;
  });

  try {
    const delivery = await sendReminder(input.client, input.config, reminder, input.scheduledAgent);
    const nextScheduledFor = reminder.recurrence
      ? nextReminderOccurrence(reminder.recurrence, reminder.timezone, new Date(), reminder.scheduledFor)
      : undefined;
    const saved = await input.repo.completeReminderOccurrence({
      reminderId: reminder.reminderId,
      channelId: delivery.message.channelId,
      messageId: delivery.message.id,
      outcome: delivery.outcome,
      executionId: delivery.executionId,
      nextScheduledFor,
    });
    if (saved?.autoPausedAt && !reminder.autoPausedAt) {
      await sendDiscordNotification({
        channel: delivery.channel,
        content: `<@${reminder.requesterId}> I paused schedule \`${reminder.reminderId}\` after ${saved.consecutiveFailures} failed runs. Ask me to resume it when you’re ready.`,
        mentionUserId: reminder.requesterId,
        deliveryKey: `schedule-auto-paused:${reminder.reminderId}:${reminder.occurrenceSequence}`,
        maxChars: input.config.maxReplyChars,
        logger,
      }).catch(async (error) => {
        logger.warn({ err: error, reminderId: reminder.reminderId }, "Failed to notify requester about auto-paused schedule");
        await recordBackgroundJobEvent(runtime, {
          eventName: "schedule.auto_pause_notification.failed",
          summary: "Could not deliver the schedule auto-pause notification.",
          level: "warn",
          metadata: { reminderId: reminder.reminderId },
        }).catch(() => undefined);
      });
    }
    await recordBackgroundJobEvent(runtime, {
      eventName: "reminder.delivery.sent",
      summary: "Scheduled reminder delivered",
      metadata: {
        reminderId: reminder.reminderId,
        channelId: delivery.message.channelId,
        messageId: delivery.message.id,
        deliveryKind: reminder.deliveryKind,
        outcome: delivery.outcome,
        autoPaused: Boolean(saved?.autoPausedAt),
      },
      durationMs: durationMs(startedAt),
    });
    await finishBackgroundJobRuntime(runtime, {
      status: "succeeded",
      summary: "Scheduled reminder delivered.",
      metadata: {
        reminderId: reminder.reminderId,
        messageId: delivery.message.id,
        deliveryKind: reminder.deliveryKind,
        outcome: delivery.outcome,
        autoPaused: Boolean(saved?.autoPausedAt),
      },
      durationMs: durationMs(startedAt),
    });
    return saved?.status === "scheduled"
      ? { reminderId: saved.reminderId, scheduledFor: saved.scheduledFor, occurrenceSequence: saved.occurrenceSequence }
      : null;
  } catch (error) {
    const code = deliveryErrorCode(error);
    const terminal = isTerminalDeliveryError(error) || reminder.deliveryAttempts >= 10;
    if (terminal) {
      await input.repo.markReminderFailed({ reminderId: reminder.reminderId, errorCode: code });
      await finishBackgroundJobRuntime(runtime, {
        status: "failed",
        summary: `Scheduled reminder could not be delivered (${code}).`,
        error: code,
        metadata: { reminderId: reminder.reminderId, terminal: true },
        durationMs: durationMs(startedAt),
      });
      logger.warn({ reminderId: reminder.reminderId, errorCode: code }, "Reminder delivery permanently failed");
      return null;
    }
    await input.repo.releaseReminderDelivery({ reminderId: reminder.reminderId, errorCode: code });
    await finishBackgroundJobRuntime(runtime, {
      status: "failed",
      summary: `Scheduled reminder delivery will retry (${code}).`,
      error: code,
      metadata: { reminderId: reminder.reminderId, terminal: false },
      durationMs: durationMs(startedAt),
    });
    throw error;
  }
}

async function sendReminder(
  client: Client,
  config: AppConfig,
  reminder: ScheduledReminder,
  scheduledAgent?: ScheduledAgentRequestRunner,
): Promise<{
  message: Message;
  outcome: ScheduleRunStatus;
  executionId: string | null;
  channel: { send: (payload: MessageCreateOptions) => Promise<Message> };
}> {
  if (!client.isReady()) throw new Error("discord_client_not_ready");
  let channel;
  try {
    channel = await client.channels.fetch(reminder.channelId);
  } catch (error) {
    if (isPermanentDiscordLookupFailure(error)) throw new TerminalReminderDeliveryError("channel_unavailable");
    throw error;
  }
  if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== reminder.guildId || !("send" in channel)) {
    throw new TerminalReminderDeliveryError("channel_unavailable");
  }
  let requester;
  try {
    requester = await channel.guild.members.fetch(reminder.requesterId);
  } catch (error) {
    if (isPermanentDiscordLookupFailure(error)) throw new TerminalReminderDeliveryError("requester_unavailable");
    throw error;
  }
  if (!channel.permissionsFor(requester)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new TerminalReminderDeliveryError("requester_cannot_view_channel");
  }
  if (channel.isThread()) {
    if (channel.type === ChannelType.PrivateThread) {
      try {
        await channel.members.fetch(reminder.requesterId);
      } catch (error) {
        if (isPermanentDiscordLookupFailure(error)) throw new TerminalReminderDeliveryError("requester_cannot_view_channel");
        throw error;
      }
    }
    if (channel.archived) await channel.setArchived(false, "Delivering a scheduled reminder");
  }
  if (reminder.deliveryKind === "agent") {
    if (!scheduledAgent) throw new Error("scheduled_agent_unavailable");
    const result = await scheduledAgent.execute(
      reminder,
      channel as unknown as { send: (payload: MessageCreateOptions) => Promise<Message> },
      requester.displayName ?? requester.user.username,
    );
    return {
      ...result,
      channel: channel as unknown as { send: (payload: MessageCreateOptions) => Promise<Message> },
    };
  }
  const message = await sendDiscordNotification({
    channel: channel as unknown as { send: (payload: MessageCreateOptions) => Promise<Message> },
    content: `<@${reminder.requesterId}> reminder: ${reminder.reminderText}`,
    mentionUserId: reminder.requesterId,
    deliveryKey: `reminder:${reminder.reminderId}:${reminder.occurrenceSequence}`,
    maxChars: config.maxReplyChars,
    logger,
  });
  return {
    message,
    outcome: "succeeded",
    executionId: null,
    channel: channel as unknown as { send: (payload: MessageCreateOptions) => Promise<Message> },
  };
}

class TerminalReminderDeliveryError extends Error {}

function isPermanentDiscordLookupFailure(error: unknown) {
  const source = error as { code?: number; rawError?: { code?: number } };
  const code = Number(source.code ?? source.rawError?.code);
  return [10003, 10004, 10007, 50001, 50013].includes(code);
}

function deliveryErrorCode(error: unknown) {
  if (error instanceof TerminalReminderDeliveryError) return error.message;
  const failure = (error as { discordFailureReason?: string }).discordFailureReason;
  if (failure === "missing_access" || failure === "missing_permissions" || failure === "unknown_message") return failure;
  if (error instanceof Error && error.message === "discord_client_not_ready") return error.message;
  return "delivery_error";
}

function isTerminalDeliveryError(error: unknown) {
  if (error instanceof TerminalReminderDeliveryError) return true;
  if (isPermanentDiscordLookupFailure(error)) return true;
  const failure = (error as { discordFailureReason?: string }).discordFailureReason;
  return failure === "missing_access" || failure === "missing_permissions" || failure === "unknown_message";
}
