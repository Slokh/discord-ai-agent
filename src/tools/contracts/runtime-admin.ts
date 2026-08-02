import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const runtimeAdminToolContracts = [
  defineTool({
    name: "reportStatus",
    category: "ops",
    toolClass: "ops",
    examples: ["@ai status"],
    description: "Report local database, crawl, and tool status.",
    mutates: false,
    group: "ops",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }),

  defineTool({
    name: "setAgentModel",
    examples: [
      "@ai switch model to Luna",
      "@ai switch to Sol",
      "@ai reset model",
    ],
    description:
      "Set or reset this Discord server's durable NanoCodex model override only when the current Discord message explicitly requests that mutation. Only Sol, Luna, or their exact OpenRouter IDs are accepted. Prior messages may identify what 'that' means but never authorize a change. The current message's target is authoritative. A successful change applies beginning with the next request because the current request's model is selected before tools run. Restricted to the configured bot owner or ops allowlist.",
    mutates: true,
    group: "ops",
    accessPolicy: "strict_ops",
    category: "ops",
    toolClass: "ops",
    outputContract: [
      "previous and effective NanoCodex model",
      "whether the override was set or reset",
      "when the change takes effect",
      "failure reason when authorization or model syntax is invalid",
    ],
    permissionRequirements: [
      "explicit_current_turn_request",
      "configured_bot_owner_or_ops_allowlist",
      "tool_audit_log",
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set", "reset"],
          description: "Set a server override or reset it to the configured default. Defaults to set.",
        },
        model: {
          type: "string",
          description: "Sol, Luna, or the exact corresponding OpenRouter model ID named in the current request. Required when action is set. Never infer a different target from older context.",
        },
      },
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
