import { listMyReminders, setReminder } from "../reminderTools.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const reminderToolHandlers = {
  setReminder: async (ctx, route) => setReminder(ctx, {
    action: typeof route.arguments?.action === "string" ? route.arguments.action : undefined,
    reminderId: typeof route.arguments?.reminder_id === "string" ? route.arguments.reminder_id : undefined,
    deliveryKind: typeof route.arguments?.delivery_mode === "string" ? route.arguments.delivery_mode : undefined,
    ...reminderArguments(route.arguments),
    removeRecurrence: route.arguments?.remove_recurrence === true,
    updateScope: typeof route.arguments?.update_scope === "string" ? route.arguments.update_scope : undefined,
  }),
  listMyReminders: async (ctx) => listMyReminders(ctx),
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

function reminderArguments(argumentsValue: Record<string, unknown> | undefined) {
  return {
    reminder: typeof argumentsValue?.reminder === "string" ? argumentsValue.reminder : undefined,
    scheduledFor: typeof argumentsValue?.scheduled_for === "string" ? argumentsValue.scheduled_for : undefined,
    timezone: typeof argumentsValue?.timezone === "string" ? argumentsValue.timezone : undefined,
    recurrence: reminderRecurrenceArguments(argumentsValue?.recurrence),
  };
}

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
