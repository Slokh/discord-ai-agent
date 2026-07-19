import { defineTool, TOOL_GROUPS, type ToolRegistryEntry } from "../toolDefinition.js";

export const coreToolContracts = [
  defineTool({
    name: "listTools",
    category: "ops",
    toolClass: "ops",
    examples: ["@ai tools"],
    description: "List Discord AI Agent's available local and hosted tools.",
    userVisible: true,
    mutates: false,
    group: "core",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }),

  defineTool({
    name: "requestAdditionalTools",
    examples: ["@ai I need another capability"],
    description:
      "Escalation valve: request additional tool groups when the current scoped tools are insufficient, including presentation for useful native Discord UI. Use this instead of guessing when a needed capability is missing.",
    userVisible: false,
    mutates: false,
    group: "core",
    category: "ops",
    toolClass: "ops",
    outputContract: ["requested groups", "newly available tool names", "reason"],
    parameters: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: { type: "string", enum: TOOL_GROUPS },
          description: `Optional tool groups to add; omit to request all groups. Valid groups: ${TOOL_GROUPS.join(", ")}.`
        },
        reason: { type: "string", description: "Why more tools are needed." }
      },
      required: ["reason"],
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
