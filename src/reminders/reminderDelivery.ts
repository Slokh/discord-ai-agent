import { ChannelType, PermissionFlagsBits, type Client, type Message, type MessageCreateOptions } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository, ScheduledReminder } from "../db/repositories.js";
import { sendDiscordNotification } from "../discord/responseSink.js";
import {
  finishBackgroundJobRuntime,
  recordBackgroundJobEvent,
  startBackgroundJobRuntime,
} from "../observability/backgroundJobRuntime.js";
import { durationMs, logger } from "../util/logger.js";

export type ReminderDeliveryRunner = {
  deliver: (reminderId: string) => Promise<void>;
  listDueReminderIds: () => Promise<string[]>;
};

export function createReminderDeliveryRunner(input: {
  client: Client;
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
}): ReminderDeliveryRunner {
  return {
    listDueReminderIds: () => input.repo.listDueReminderIds(),
    deliver: async (reminderId) => deliverReminder({ ...input, reminderId }),
  };
}

async function deliverReminder(input: {
  client: Client;
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  reminderId: string;
}) {
  const reminder = await input.repo.claimReminderForDelivery({ reminderId: input.reminderId });
  if (!reminder) return;
  const startedAt = Date.now();
  const runtime = await startBackgroundJobRuntime({
    agentRuntime: input.agentRuntime,
    executionId: `reminder-delivery-${reminder.reminderId}-${reminder.deliveryAttempts}`,
    traceId: reminder.reminderId,
    kind: "reminder_delivery",
    title: "Scheduled reminder delivery",
    request: `Deliver scheduled reminder ${reminder.reminderId}.`,
    source: "pgboss.reminder",
    guildId: reminder.guildId,
    channelId: reminder.channelId,
    metadata: { reminderId: reminder.reminderId, attempt: reminder.deliveryAttempts },
  }).catch((error) => {
    logger.warn({ err: error, reminderId: reminder.reminderId }, "Failed to create reminder delivery runtime");
    return null;
  });

  try {
    const message = await sendReminder(input.client, input.config, reminder);
    await input.repo.markReminderDelivered({
      reminderId: reminder.reminderId,
      channelId: message.channelId,
      messageId: message.id,
    });
    await recordBackgroundJobEvent(runtime, {
      eventName: "reminder.delivery.sent",
      summary: "Scheduled reminder delivered",
      metadata: { reminderId: reminder.reminderId, channelId: message.channelId, messageId: message.id },
      durationMs: durationMs(startedAt),
    });
    await finishBackgroundJobRuntime(runtime, {
      status: "succeeded",
      summary: "Scheduled reminder delivered.",
      metadata: { reminderId: reminder.reminderId, messageId: message.id },
      durationMs: durationMs(startedAt),
    });
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
      return;
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

async function sendReminder(client: Client, config: AppConfig, reminder: ScheduledReminder): Promise<Message> {
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
  return sendDiscordNotification({
    channel: channel as unknown as { send: (payload: MessageCreateOptions) => Promise<Message> },
    content: `<@${reminder.requesterId}> reminder: ${reminder.reminderText}`,
    mentionUserId: reminder.requesterId,
    deliveryKey: `reminder:${reminder.reminderId}`,
    maxChars: config.maxReplyChars,
    logger,
  });
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
