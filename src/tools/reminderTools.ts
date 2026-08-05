import { createHash, randomUUID } from "node:crypto";
import { summarizeForAudit } from "../util/text.js";
import { DEFAULT_USER_TIMEZONE, formatTimezoneDateTime, normalizeIanaTimezone, USER_TIMEZONE_PREFERENCE_KEY } from "../util/timezone.js";
import type { AgentResponse, ToolContext } from "./types.js";

const RFC3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export async function createReminder(
  ctx: ToolContext,
  input: { reminder?: string; scheduledFor?: string; timezone?: string },
): Promise<AgentResponse> {
  const reminderText = input.reminder?.trim();
  if (!reminderText || reminderText.length > 1500) return failure(ctx, "createReminder", input, "reminder_text_invalid", "Tell me what to remind you about (up to 1,500 characters).");
  const scheduledFor = parseScheduledInstant(input.scheduledFor);
  if (!scheduledFor) return failure(ctx, "createReminder", input, "reminder_time_invalid", "I need an exact future date and time before I can schedule that reminder.");
  if (scheduledFor.getTime() <= Date.now()) return failure(ctx, "createReminder", input, "reminder_time_not_future", "That reminder time has already passed. Give me a future date and time.");

  const timezone = input.timezone
    ? normalizeIanaTimezone(input.timezone)
    : await storedTimezone(ctx);
  if (!timezone) return failure(ctx, "createReminder", input, "reminder_timezone_invalid", "I couldn’t validate the timezone for that reminder.");
  const sourceMessageId = ctx.requestMessageId ?? ctx.requesterScope?.messageId;
  if (!sourceMessageId) return failure(ctx, "createReminder", input, "reminder_source_missing", "I couldn’t bind this reminder to the current Discord request, so nothing was scheduled.");

  const requestKey = createHash("sha256")
    .update([ctx.guildId, ctx.channelId, ctx.userId, sourceMessageId, reminderText, scheduledFor.toISOString()].join("\0"))
    .digest("hex");
  const reminder = await ctx.repo.createReminder({
    reminderId: `r_${randomUUID()}`,
    requestKey,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    requesterId: ctx.userId,
    sourceMessageId,
    reminderText,
    timezone,
    scheduledFor,
  });
  await ctx.jobs?.enqueueReminderDelivery(reminder.reminderId, reminder.scheduledFor).catch(() => null);
  await audit(ctx, "createReminder", input, { reminderId: reminder.reminderId, scheduledFor: reminder.scheduledFor.toISOString() }).catch(() => undefined);
  return success(
    `Reminder \`${reminder.reminderId}\` is set for ${formatTimezoneDateTime(reminder.scheduledFor, reminder.timezone)}: ${reminder.reminderText}`,
    "reminder_created",
  );
}

export async function listMyReminders(ctx: ToolContext): Promise<AgentResponse> {
  const reminders = await ctx.repo.listScheduledRemindersForRequester({ guildId: ctx.guildId, requesterId: ctx.userId, limit: 25 });
  await audit(ctx, "listMyReminders", {}, { count: reminders.length }).catch(() => undefined);
  if (reminders.length === 0) return success("You don’t have any upcoming reminders in this server.", "reminder_list");
  const lines = reminders.map((reminder) => `- \`${reminder.reminderId}\` — ${formatTimezoneDateTime(reminder.scheduledFor, reminder.timezone)} — ${reminder.reminderText}`);
  return success(`Your upcoming reminders:\n${lines.join("\n")}`, "reminder_list");
}

export async function cancelReminder(ctx: ToolContext, input: { reminderId?: string }): Promise<AgentResponse> {
  const reminderId = input.reminderId?.trim();
  if (!reminderId) return failure(ctx, "cancelReminder", input, "reminder_id_missing", "Tell me which reminder to cancel. I can list your upcoming reminders first.");
  const reminder = await ctx.repo.cancelReminderForRequester({ reminderId, guildId: ctx.guildId, requesterId: ctx.userId });
  if (!reminder) return failure(ctx, "cancelReminder", input, "reminder_not_found", "I couldn’t find a scheduled reminder with that ID among your reminders in this server.");
  await audit(ctx, "cancelReminder", input, { reminderId }).catch(() => undefined);
  return success(`Cancelled reminder \`${reminderId}\`: ${reminder.reminderText}`, "reminder_cancelled");
}

function parseScheduledInstant(value: string | undefined): Date | null {
  const candidate = value?.trim();
  if (!candidate || !RFC3339_WITH_ZONE.test(candidate) || !validCalendarDateTime(candidate)) return null;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function validCalendarDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function storedTimezone(ctx: ToolContext): Promise<string> {
  const preference = await ctx.repo.getUserPreference(ctx.userId, USER_TIMEZONE_PREFERENCE_KEY);
  return normalizeIanaTimezone(typeof preference?.value === "string" ? preference.value : undefined) ?? DEFAULT_USER_TIMEZONE;
}

function success(content: string, kind: string): AgentResponse {
  return { content, status: "ok", retryable: false, outcome: { kind, state: "succeeded", terminal: true } };
}

async function failure(ctx: ToolContext, toolName: "createReminder" | "cancelReminder", input: unknown, errorCode: string, content: string): Promise<AgentResponse> {
  await audit(ctx, toolName, input, undefined, errorCode).catch(() => undefined);
  return { content, status: "error", errorCode, retryable: false, outcome: { kind: "reminder", state: "failed", terminal: true } };
}

async function audit(ctx: ToolContext, toolName: string, input: unknown, result?: unknown, error?: string) {
  await ctx.repo.auditTool({
    traceId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName,
    argumentsSummary: summarizeForAudit(input),
    resultSummary: result ? summarizeForAudit(result) : undefined,
    error,
  });
}
