import { createReminder, listMyReminders, manageReminder } from "../reminderTools.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const reminderToolHandlers = {
  createReminder: async (ctx, route) => createReminder(ctx, {
    reminder: typeof route.arguments?.reminder === "string" ? route.arguments.reminder : undefined,
    scheduledFor: typeof route.arguments?.scheduled_for === "string" ? route.arguments.scheduled_for : undefined,
    timezone: typeof route.arguments?.timezone === "string" ? route.arguments.timezone : undefined,
    recurrence: reminderRecurrenceArguments(route.arguments?.recurrence),
  }),
  listMyReminders: async (ctx) => listMyReminders(ctx),
  manageReminder: async (ctx, route) => manageReminder(ctx, {
    action: typeof route.arguments?.action === "string" ? route.arguments.action : undefined,
    reminderId: typeof route.arguments?.reminder_id === "string" ? route.arguments.reminder_id : undefined,
  }),
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

function reminderRecurrenceArguments(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const recurrence = value as Record<string, unknown>;
  return {
    frequency: typeof recurrence.frequency === "string" ? recurrence.frequency : undefined,
    interval: typeof recurrence.interval === "number" ? recurrence.interval : undefined,
    localTime: typeof recurrence.local_time === "string" ? recurrence.local_time : undefined,
    weekdays: Array.isArray(recurrence.weekdays) ? recurrence.weekdays.filter((day): day is string => typeof day === "string") : undefined,
    dayOfMonth: typeof recurrence.day_of_month === "number" ? recurrence.day_of_month : undefined,
  };
}
