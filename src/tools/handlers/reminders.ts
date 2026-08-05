import { cancelReminder, createReminder, listMyReminders } from "../reminderTools.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const reminderToolHandlers = {
  createReminder: async (ctx, route) => createReminder(ctx, {
    reminder: typeof route.arguments?.reminder === "string" ? route.arguments.reminder : undefined,
    scheduledFor: typeof route.arguments?.scheduled_for === "string" ? route.arguments.scheduled_for : undefined,
    timezone: typeof route.arguments?.timezone === "string" ? route.arguments.timezone : undefined,
  }),
  listMyReminders: async (ctx) => listMyReminders(ctx),
  cancelReminder: async (ctx, route) => cancelReminder(ctx, {
    reminderId: typeof route.arguments?.reminder_id === "string" ? route.arguments.reminder_id : undefined,
  }),
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
