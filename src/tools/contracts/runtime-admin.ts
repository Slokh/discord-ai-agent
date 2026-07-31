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
    name: "setAgentModel",
    examples: [
      "@ai switch model to moonshotai/kimi-k3",
      "@ai switch to Sonnet 5",
      "@ai reset model",
    ],
    description:
      "Set or reset this Discord server's durable primary chat-model override only when the current Discord message explicitly requests that mutation. A verified OpenRouter model ID or unambiguous catalog name/alias is accepted; prior messages may identify what 'that' means but never authorize a change. The current message's target is authoritative, even if a model-generated tool argument differs. A successful change applies to remaining work in the same request and future requests, and does not change the recovery model. Restricted to the configured bot owner or ops allowlist.",
    userVisible: true,
    mutates: true,
    group: "ops",
    category: "ops",
    toolClass: "ops",
    outputContract: [
      "previous and effective primary chat model",
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
          description: "The model named in the current request, as an OpenRouter provider/model ID or unambiguous catalog alias. Required when action is set. Never infer a different target from older context.",
        },
      },
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
