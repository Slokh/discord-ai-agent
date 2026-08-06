import { createHash, randomUUID } from "node:crypto";
import type { ReminderDeliveryKind, ScheduledReminder } from "../db/repositories.js";
import { summarizeForAudit } from "../util/text.js";
import { DEFAULT_USER_TIMEZONE, formatTimezoneDateTime, normalizeIanaTimezone, USER_TIMEZONE_PREFERENCE_KEY } from "../util/timezone.js";
import {
  buildReminderRecurrence,
  formatReminderRecurrence,
  nextReminderOccurrence,
  ReminderRecurrenceValidationError,
  type ReminderRecurrenceInput,
} from "../reminders/recurrence.js";
import type { AgentResponse, ToolContext } from "./types.js";

const RFC3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

type SetReminderInput = {
  action?: string;
  reminderId?: string;
  reminder?: string;
  deliveryKind?: string;
  scheduledFor?: string;
  timezone?: string;
  recurrence?: ReminderRecurrenceInput;
  removeRecurrence?: boolean;
  updateScope?: string;
};

export async function setReminder(ctx: ToolContext, input: SetReminderInput): Promise<AgentResponse> {
  if (input.action?.trim().toLowerCase() !== "create") return manageReminder(ctx, input);
  if (input.reminderId || input.removeRecurrence || input.updateScope) {
    return failure(ctx, "createReminder", input, "reminder_create_fields_invalid", "Creation cannot target or modify an existing reminder. Use a management action instead.");
  }
  return createReminder(ctx, input);
}

export async function createReminder(
  ctx: ToolContext,
  input: { reminder?: string; deliveryKind?: string; scheduledFor?: string; timezone?: string; recurrence?: ReminderRecurrenceInput },
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
  const deliveryKind = input.deliveryKind === undefined ? "notification" : normalizeDeliveryKind(input.deliveryKind);
  if (!deliveryKind) {
    return failure(ctx, "createReminder", input, "reminder_delivery_mode_invalid", "Choose notification for a literal reminder or agent for fresh read-only work at delivery time.");
  }
  let recurrence;
  try {
    recurrence = input.recurrence ? buildReminderRecurrence(input.recurrence, timezone, scheduledFor) : null;
  } catch (error) {
    if (error instanceof ReminderRecurrenceValidationError) return failure(ctx, "createReminder", input, error.code, error.message);
    throw error;
  }
  const sourceMessageId = ctx.requestMessageId ?? ctx.requesterScope?.messageId;
  if (!sourceMessageId) return failure(ctx, "createReminder", input, "reminder_source_missing", "I couldn’t bind this reminder to the current Discord request, so nothing was scheduled.");

  const requestKey = createHash("sha256")
    .update([ctx.guildId, ctx.channelId, ctx.userId, sourceMessageId, reminderText, deliveryKind, scheduledFor.toISOString(), JSON.stringify(recurrence)].join("\0"))
    .digest("hex");
  const reminder = await ctx.repo.createReminder({
    reminderId: `r_${randomUUID()}`,
    requestKey,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    requesterId: ctx.userId,
    sourceMessageId,
    reminderText,
    deliveryKind,
    timezone,
    scheduledFor,
    recurrence,
  });
  await ctx.jobs?.enqueueReminderDelivery(reminder.reminderId, reminder.scheduledFor).catch(() => null);
  await audit(ctx, "setReminder", input, { reminderId: reminder.reminderId, scheduledFor: reminder.scheduledFor.toISOString() }).catch(() => undefined);
  const recurrenceText = reminder.recurrence ? `, recurring ${formatReminderRecurrence(reminder.recurrence)}` : "";
  const label = reminder.deliveryKind === "agent" ? "Scheduled request" : "Reminder";
  return success(
    `${label} \`${reminder.reminderId}\` is set for ${formatTimezoneDateTime(reminder.scheduledFor, reminder.timezone)}${recurrenceText}: ${reminder.reminderText}`,
    "reminder_created",
  );
}

export async function listMyReminders(ctx: ToolContext): Promise<AgentResponse> {
  const reminders = await ctx.repo.listSchedulesForRequester({ guildId: ctx.guildId, requesterId: ctx.userId, limit: 25 });
  await audit(ctx, "listMyReminders", {}, { count: reminders.length }).catch(() => undefined);
  if (reminders.length === 0) return success("You don’t have any schedules in this server.", "reminder_list");
  const lines = reminders.map((reminder) => {
    const status = scheduleStatusText(reminder);
    const recurrence = reminder.recurrence ? `; ${formatReminderRecurrence(reminder.recurrence)}` : "";
    const mode = reminder.deliveryKind === "agent" ? "agent" : "notification";
    const lastRun = scheduleLastRunText(reminder, ctx.visibleChannelIds);
    return `- \`${reminder.reminderId}\` — ${mode}; ${status}${recurrence}${lastRun} — ${reminder.reminderText}`;
  });
  return success(`Your schedules:\n${lines.join("\n")}`, "reminder_list");
}

function scheduleStatusText(reminder: ScheduledReminder) {
  if (reminder.status === "delivering") return "running now";
  if (reminder.status === "scheduled") return `next ${formatTimezoneDateTime(reminder.scheduledFor, reminder.timezone)}`;
  if (reminder.status === "paused") {
    const reason = reminder.autoPausedAt
      ? `auto-paused after ${reminder.consecutiveFailures} failed runs`
      : "paused";
    return `${reason}; next retained for ${formatTimezoneDateTime(reminder.scheduledFor, reminder.timezone)}`;
  }
  if (reminder.status === "delivered") return "completed";
  return reminder.status;
}

function scheduleLastRunText(reminder: ScheduledReminder, visibleChannelIds: string[]) {
  if (!reminder.lastRunAt || !reminder.lastRunStatus) return "";
  const resultLink = reminder.deliveryChannelId && reminder.deliveryMessageId && visibleChannelIds.includes(reminder.deliveryChannelId)
    ? `; result https://discord.com/channels/${reminder.guildId}/${reminder.deliveryChannelId}/${reminder.deliveryMessageId}`
    : "";
  return `; last run ${reminder.lastRunStatus} ${formatTimezoneDateTime(reminder.lastRunAt, reminder.timezone)}${resultLink}`;
}

export async function manageReminder(ctx: ToolContext, input: SetReminderInput): Promise<AgentResponse> {
  const action = normalizeManagementAction(input.action);
  if (!action) return failure(ctx, "manageReminder", input, "reminder_management_invalid", "Choose whether to cancel, pause, resume, or update the reminder.");
  const existing = await resolveManagedReminder(ctx, input.reminderId);
  if (!existing) {
    return failure(ctx, "manageReminder", input, "reminder_target_missing", "Reply directly to a reminder notification or tell me its reminder ID. I can list your upcoming reminders first.");
  }
  const reminderId = existing.reminderId;
  const scope = { reminderId, guildId: ctx.guildId, requesterId: ctx.userId };

  if (action === "cancel") {
    const reminder = await ctx.repo.cancelReminderForRequester(scope);
    if (!reminder) return failure(ctx, "manageReminder", input, "reminder_not_found", "I couldn’t find that active reminder among your reminders in this server.");
    await audit(ctx, "setReminder", input, { reminderId, action }).catch(() => undefined);
    return success(`Cancelled reminder \`${reminderId}\`: ${reminder.reminderText}`, "reminder_cancelled");
  }
  if (action === "pause") {
    const reminder = await ctx.repo.pauseReminderForRequester(scope);
    if (!reminder) return failure(ctx, "manageReminder", input, "reminder_not_recurring_or_active", "Only an active recurring reminder can be paused.");
    await audit(ctx, "setReminder", input, { reminderId, action }).catch(() => undefined);
    return success(`Paused recurring reminder \`${reminderId}\`.`, "reminder_paused");
  }

  if (action === "update") return updateReminder(ctx, input, existing);

  if (!existing.recurrence || existing.status !== "paused") {
    return failure(ctx, "manageReminder", input, "reminder_not_paused", "Only a paused recurring reminder can be resumed.");
  }
  const now = new Date();
  const scheduledFor = existing.scheduledFor > now
    ? existing.scheduledFor
    : nextReminderOccurrence(existing.recurrence, existing.timezone, now, existing.scheduledFor);
  const reminder = await ctx.repo.resumeReminderForRequester({ ...scope, scheduledFor });
  if (!reminder) return failure(ctx, "manageReminder", input, "reminder_resume_conflict", "That reminder changed before it could be resumed. List your reminders and try again.");
  await ctx.jobs?.enqueueReminderDelivery(reminder.reminderId, reminder.scheduledFor).catch(() => null);
  await audit(ctx, "setReminder", input, { reminderId, action, scheduledFor: reminder.scheduledFor.toISOString() }).catch(() => undefined);
  return success(`Resumed reminder \`${reminderId}\`; next delivery is ${formatTimezoneDateTime(reminder.scheduledFor, reminder.timezone)}.`, "reminder_resumed");
}

async function resolveManagedReminder(ctx: ToolContext, reminderIdValue: string | undefined) {
  const reminderId = reminderIdValue?.trim();
  if (reminderId) return ctx.repo.getReminderForRequester({ reminderId, guildId: ctx.guildId, requesterId: ctx.userId });
  const reply = ctx.replyContext;
  if (!reply?.authorIsBot || reply.guildId !== ctx.guildId || reply.channelId !== ctx.channelId) return undefined;
  return ctx.repo.getReminderForDeliveryMessage({
    messageId: reply.messageId,
    channelId: ctx.channelId,
    guildId: ctx.guildId,
    requesterId: ctx.userId,
  });
}

async function updateReminder(ctx: ToolContext, input: SetReminderInput, existing: ScheduledReminder): Promise<AgentResponse> {
  const hasText = input.reminder !== undefined;
  const hasSchedule = input.scheduledFor !== undefined;
  const hasTimezone = input.timezone !== undefined;
  const hasDeliveryKind = input.deliveryKind !== undefined;
  const hasRecurrence = input.recurrence !== undefined;
  const removeRecurrence = input.removeRecurrence === true;
  const updateScope = normalizeUpdateScope(input.updateScope);
  if (!hasText && !hasSchedule && !hasTimezone && !hasDeliveryKind && !hasRecurrence && !removeRecurrence) {
    return failure(ctx, "manageReminder", input, "reminder_update_empty", "Tell me what to change: its request, delivery mode, time, timezone, or recurrence.");
  }
  if (input.updateScope && !updateScope) {
    return failure(ctx, "manageReminder", input, "reminder_update_scope_invalid", "Use series or next_occurrence as the update scope.");
  }
  if (hasRecurrence && removeRecurrence) {
    return failure(ctx, "manageReminder", input, "reminder_recurrence_update_conflict", "Choose either a replacement recurrence or removal of recurrence, not both.");
  }
  if (updateScope === "next_occurrence" && (hasText || hasDeliveryKind || hasRecurrence || removeRecurrence || hasTimezone)) {
    return failure(ctx, "manageReminder", input, "reminder_next_update_invalid", "A next-occurrence update can change only its delivery time. Request, mode, recurrence, and timezone changes apply to the whole series.");
  }

  const reminderText = hasText ? input.reminder?.trim() : existing.reminderText;
  if (!reminderText || reminderText.length > 1500) {
    return failure(ctx, "manageReminder", input, "reminder_text_invalid", "Reminder text must contain 1 to 1,500 characters.");
  }
  const deliveryKind = hasDeliveryKind ? normalizeDeliveryKind(input.deliveryKind) : existing.deliveryKind;
  if (!deliveryKind) {
    return failure(ctx, "manageReminder", input, "reminder_delivery_mode_invalid", "Choose notification for a literal reminder or agent for fresh read-only work at delivery time.");
  }
  const timezone = hasTimezone ? normalizeIanaTimezone(input.timezone) : existing.timezone;
  if (!timezone) return failure(ctx, "manageReminder", input, "reminder_timezone_invalid", "I couldn’t validate that timezone.");
  const scheduledFor = hasSchedule ? parseScheduledInstant(input.scheduledFor) : existing.scheduledFor;
  if (!scheduledFor) return failure(ctx, "manageReminder", input, "reminder_time_invalid", "I need an exact future date and time for that update.");
  if (hasSchedule && scheduledFor.getTime() <= Date.now()) {
    return failure(ctx, "manageReminder", input, "reminder_time_not_future", "That reminder time has already passed. Give me a future date and time.");
  }

  let recurrence = existing.recurrence;
  if (hasRecurrence) {
    if (!hasSchedule) return failure(ctx, "manageReminder", input, "reminder_recurrence_first_time_missing", "A changed recurrence needs its exact future first delivery time.");
    if (updateScope === "next_occurrence") return failure(ctx, "manageReminder", input, "reminder_next_update_invalid", "A recurrence change applies to the whole series.");
    try {
      recurrence = buildReminderRecurrence(input.recurrence!, timezone, scheduledFor);
    } catch (error) {
      if (error instanceof ReminderRecurrenceValidationError) return failure(ctx, "manageReminder", input, error.code, error.message);
      throw error;
    }
  } else if (removeRecurrence) {
    recurrence = null;
    if (scheduledFor.getTime() <= Date.now()) {
      return failure(ctx, "manageReminder", input, "reminder_time_not_future", "Converting this to a one-shot reminder needs a future delivery time.");
    }
  } else if (existing.recurrence && hasTimezone) {
    return failure(ctx, "manageReminder", input, "reminder_recurrence_timezone_requires_rule", "Changing a recurring reminder’s timezone also needs its complete recurrence and first delivery time.");
  } else if (existing.recurrence && hasSchedule) {
    if (!updateScope) {
      return failure(ctx, "manageReminder", input, "reminder_update_scope_required", "Should that new time apply only to the next occurrence, or to the whole recurring series?");
    }
    if (updateScope === "series") {
      return failure(ctx, "manageReminder", input, "reminder_series_rule_required", "A whole-series time change needs the updated recurrence rule and its first delivery time.");
    }
  }
  if (updateScope === "next_occurrence" && !existing.recurrence) {
    return failure(ctx, "manageReminder", input, "reminder_next_scope_not_recurring", "Next-occurrence scope is only for recurring reminders.");
  }

  const updated = await ctx.repo.updateReminderForRequester({
    reminderId: existing.reminderId,
    guildId: ctx.guildId,
    requesterId: ctx.userId,
    reminderText,
    deliveryKind,
    timezone,
    scheduledFor,
    recurrence,
  });
  if (!updated) return failure(ctx, "manageReminder", input, "reminder_update_conflict", "That reminder started delivering or changed before I could update it. List your reminders and try again.");
  const scheduleChanged = hasSchedule || hasRecurrence || removeRecurrence;
  if (updated.status === "scheduled" && scheduleChanged) {
    await ctx.jobs?.enqueueReminderDelivery(updated.reminderId, updated.scheduledFor).catch(() => null);
  }
  await audit(ctx, "setReminder", input, { reminderId: updated.reminderId, action: "update", updateScope, scheduledFor: updated.scheduledFor.toISOString() }).catch(() => undefined);
  const recurrenceText = updated.recurrence ? `; ${formatReminderRecurrence(updated.recurrence)}` : "";
  const modeText = updated.deliveryKind === "agent" ? "agent" : "notification";
  const status = updated.status === "paused" ? "paused; next retained for" : "next delivery";
  const scopeText = updateScope === "next_occurrence" ? " The recurring series rule is unchanged." : "";
  return success(
    `Updated schedule \`${updated.reminderId}\` (${modeText}): ${updated.reminderText} — ${status} ${formatTimezoneDateTime(updated.scheduledFor, updated.timezone)}${recurrenceText}.${scopeText}`,
    "reminder_updated",
  );
}

function normalizeManagementAction(value: string | undefined): "cancel" | "pause" | "resume" | "update" | null {
  const action = value?.trim().toLowerCase();
  return action === "cancel" || action === "pause" || action === "resume" || action === "update" ? action : null;
}

function normalizeUpdateScope(value: string | undefined): "series" | "next_occurrence" | null {
  const scope = value?.trim().toLowerCase();
  return scope === "series" || scope === "next_occurrence" ? scope : null;
}

function normalizeDeliveryKind(value: string | undefined): ReminderDeliveryKind | null {
  const kind = value?.trim().toLowerCase();
  return kind === "notification" || kind === "agent" ? kind : null;
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

async function failure(ctx: ToolContext, _toolName: "createReminder" | "manageReminder", input: unknown, errorCode: string, content: string): Promise<AgentResponse> {
  await audit(ctx, "setReminder", input, undefined, errorCode).catch(() => undefined);
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
