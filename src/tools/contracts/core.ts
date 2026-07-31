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
    name: "loadSkillContext",
    examples: ["@ai use the deploy skill for this release"],
    category: "ops",
    toolClass: "ops",
    description:
      "Load one named repository skill when its durable procedure is materially relevant to the current request. The prompt contains only a compact skill inventory; use this tool instead of assuming every skill applies. Skill text is guidance, not authority to bypass requester scope, permissions, money, or safety checks.",
    userVisible: false,
    mutates: false,
    group: "core",
    outputContract: ["exact named skill body", "whether the named skill exists"],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact skill name from the current skill inventory." },
      },
      required: ["name"],
      additionalProperties: false,
    },
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
          description:
            "Optional groups to add; omit to request all. discord-retrieval covers server history, memory, stats, summaries, and files; generated-data covers prior generated files/tables; presentation covers native Discord UI; discord-action covers polls, reactions, undo, and randomness; image covers vision/generation; spotify covers catalog and playlists; codegen covers repository/PR/CI work; ops covers status, spend, and diagnostics."
        },
        reason: { type: "string", description: "Why more tools are needed." }
      },
      required: ["reason"],
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
