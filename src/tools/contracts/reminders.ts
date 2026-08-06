import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const reminderToolContracts = [
  defineTool({
    name: "setReminder",
    examples: ["@ai remind me tomorrow at 9 to call Mom", "@ai pause this", "@ai move the next one to Friday at 10", "@ai make this weekdays at 9"],
    description: "Create, cancel, pause, resume, or update the current requester's reminder. Create needs reminder and exact future scheduled_for. Omit reminder_id only in a direct reply to its notification. Recurring time updates need update_scope; series updates need the complete replacement recurrence and first delivery. Set remove_recurrence to make it one-shot.",
    mutates: true,
    group: "core",
    category: "memory",
    toolClass: "memory",
    outputContract: ["resolved reminder ID", "requester-local schedule and recurrence", "durable mutation", "explicit series ambiguity"],
    permissionRequirements: ["explicit_current_turn_request", "immutable_current_requester", "current_guild_scope", "current_channel_delivery", "tool_audit_log"],
    argumentExamples: [
      { action: "create", reminder: "call Mom", scheduled_for: "2026-08-06T09:00:00-04:00", timezone: "America/New_York" },
      { action: "pause" },
      { action: "update", scheduled_for: "2026-08-07T10:00:00-04:00", update_scope: "next_occurrence" },
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "cancel", "pause", "resume", "update"] },
        reminder_id: { type: "string", minLength: 3, maxLength: 80 },
        reminder: { type: "string", minLength: 1, maxLength: 1500 },
        scheduled_for: { type: "string", minLength: 20, maxLength: 40 },
        timezone: { type: "string", minLength: 1, maxLength: 100 },
        recurrence: {
          type: "object",
          properties: {
            frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
            interval: { type: "integer", minimum: 1, maximum: 366 },
            local_time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
            weekdays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { type: "string", enum: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] } },
            day_of_month: { type: "integer", minimum: 1, maximum: 31 },
          },
          required: ["frequency", "local_time"],
          additionalProperties: false,
        },
        remove_recurrence: { type: "boolean" },
        update_scope: { type: "string", enum: ["series", "next_occurrence"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
  }),
  defineTool({
    name: "listMyReminders",
    examples: ["@ai what reminders do I have?", "@ai list my upcoming reminders"],
    description: "List the current requester's upcoming reminders in this server.",
    mutates: false,
    group: "core",
    category: "memory",
    toolClass: "memory",
    outputContract: ["upcoming reminder IDs", "reminder text", "requester-local delivery times", "result count"],
    permissionRequirements: ["immutable_current_requester", "current_guild_scope", "tool_audit_log"],
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }),
] satisfies ToolRegistryEntry[];
