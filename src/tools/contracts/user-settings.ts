import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const userSettingsToolContracts = [
  defineTool({
    name: "setMyTimezone",
    examples: [
      "@ai set my timezone to America/New_York",
      "@ai use Europe/London for my dates and times",
      "@ai reset my timezone",
    ],
    description:
      "Set or reset the current requester's durable timezone override only when their current Discord message explicitly requests it. This always applies to the immutable current requester; never accept or infer another user ID. Translate a clearly named timezone into its canonical IANA identifier, such as America/New_York, Europe/London, or Asia/Tokyo. Do not infer a timezone from message activity, locale, or unrelated context. Reset removes the override and restores UTC. The change applies beginning with the next request.",
    mutates: true,
    group: "core",
    category: "memory",
    toolClass: "memory",
    outputContract: [
      "canonical effective IANA timezone",
      "whether the user override was set or reset",
      "when the change takes effect",
      "validation failure without changing the stored setting",
    ],
    permissionRequirements: [
      "explicit_current_turn_request",
      "immutable_current_requester",
      "tool_audit_log",
    ],
    argumentExamples: [
      { action: "set", timezone: "America/New_York" },
      { action: "reset" },
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set", "reset"],
          description: "Set a user override or reset it to UTC. Defaults to set.",
        },
        timezone: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Canonical IANA timezone for the current requester. Required when action is set; omit when resetting.",
        },
      },
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
