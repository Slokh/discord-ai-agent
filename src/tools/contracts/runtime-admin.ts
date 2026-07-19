import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const runtimeAdminToolContracts = [
  defineTool({
    name: "reportStatus",
    category: "ops",
    toolClass: "ops",
    examples: ["@ai status"],
    description: "Report local database, crawl, and tool status.",
    userVisible: true,
    mutates: false,
    group: "ops",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }),

  defineTool({
    name: "setUserTurnLimit",
    examples: ["@ai limit tyler to 5 posts per day"],
    description:
      "Set, clear, or list per-user daily AI turn limits. Use this when the requester asks to limit, throttle, rate-limit, or unlimit how many times a specific user can use the AI per day, or to review the current limits. A set limit overrides the global default and is enforced at Discord ingress before any model call, counted across all channels, and resets at midnight UTC. turnsPerDay accepts a positive daily cap (like 5), 0 to reject every turn, or -1 for unlimited. Pass the target's Discord user ID or mention; use findDiscordUsers to resolve a name to an ID first. Restricted to the bot owner or ops allowlist.",
    userVisible: true,
    mutates: true,
    group: "ops",
    category: "ops",
    toolClass: "ops",
    outputContract: ["action taken (set, clear, or list)", "target user ID and effective limit", "reset window", "failure reason when the user or limit is invalid"],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set", "clear", "list"],
          description: "set applies a daily limit to a user, clear removes their override, list shows all current overrides. Defaults to set."
        },
        userId: {
          type: "string",
          description: "Discord user ID or <@id> mention of the user to limit. Required for set and clear."
        },
        turnsPerDay: {
          type: "number",
          description: "Daily AI turn cap for the user. Required for set: a positive whole number like 5, 0 to reject every turn, or -1 for unlimited."
        },
        reason: {
          type: "string",
          description: "Optional short note recorded with the limit, like 'spamming every channel'."
        }
      },
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
