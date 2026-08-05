import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const reminderToolContracts = [
  defineTool({
    name: "createReminder",
    examples: ["@ai remind me tomorrow at 9 to call Mom", "@ai every weekday at 9 remind me to check the queue"],
    description: "Create a one-shot or recurring reminder for the current requester. Pass an exact future RFC 3339 first occurrence and a matching local wall-clock rule for recurrence. Never invent a missing date or time.",
    mutates: true,
    group: "core",
    category: "memory",
    toolClass: "memory",
    outputContract: ["reminder ID", "requester-local first delivery", "recurrence when present", "durable scheduling result"],
    permissionRequirements: ["explicit_current_turn_request", "immutable_current_requester", "current_channel_delivery", "tool_audit_log"],
    argumentExamples: [
      { reminder: "call Mom", scheduled_for: "2026-08-06T09:00:00-04:00", timezone: "America/New_York" },
      { reminder: "check the queue", scheduled_for: "2026-08-06T09:00:00-04:00", timezone: "America/New_York", recurrence: { frequency: "weekly", local_time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] } },
    ],
    parameters: {
      type: "object",
      properties: {
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
      },
      required: ["reminder", "scheduled_for"],
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
  defineTool({
    name: "manageReminder",
    examples: ["@ai cancel reminder r_123", "@ai pause that weekly reminder", "@ai resume reminder r_123"],
    description: "Cancel the current requester's active reminder, or pause/resume their recurring reminder, by ID. List or ask when the ID is ambiguous.",
    mutates: true,
    group: "core",
    category: "memory",
    toolClass: "memory",
    outputContract: ["reminder ID", "cancelled, paused, or resumed state", "next delivery after resume", "ownership-safe failure"],
    permissionRequirements: ["explicit_current_turn_request", "immutable_current_requester", "current_guild_scope", "tool_audit_log"],
    argumentExamples: [{ action: "cancel", reminder_id: "r_123" }, { action: "pause", reminder_id: "r_123" }, { action: "resume", reminder_id: "r_123" }],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["cancel", "pause", "resume"] },
        reminder_id: { type: "string", minLength: 3, maxLength: 80 },
      },
      required: ["action", "reminder_id"],
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
