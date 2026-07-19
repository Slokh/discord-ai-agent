import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const opsPart1ToolContracts = [
  defineTool({
    name: "createSkillDraft",
    category: "memory",
    toolClass: "memory",
    examples: ["@ai learn this for next time: movie night is on Fridays"],
    description:
      "Create or update a private database-backed Markdown skill. Use only when the user explicitly asks the agent to learn, remember, save, or update durable behavior/knowledge for next time.",
    userVisible: true,
    mutates: true,
    group: "ops",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Short stable kebab-case skill name, such as movie-night, minecraft-server, or house-rules."
        },
        instruction: {
          type: "string",
          description: "The durable instruction the user wants Discord AI Agent to remember."
        }
      },
      required: ["skillName", "instruction"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "manageSkills",
    category: "memory",
    toolClass: "memory",
    examples: ["@ai what are all your skills?"],
    description:
      "List the complete skill inventory, resolve a skill's exact name, or enable, disable, or delete private database-backed skills. Always use action=list instead of inferring the full inventory from prompt context. For content changes, list/resolve the skill first, then call createSkillDraft with its exact name.",
    userVisible: true,
    mutates: true,
    group: "ops",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "enable", "disable", "delete"] },
        skillNames: { type: "array", items: { type: "string" }, description: "Exact skill names to mutate." },
        all: { type: "boolean", description: "Apply the mutation to every private database skill only when the user explicitly asks for all." },
        query: { type: "string", description: "Optional text filter for list/skill-name resolution." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  }),

  defineTool({
    name: "getDeploymentStatus",
    toolClass: "ops",
    examples: ["@ai deployment status"],
    description:
      "Report the running deployment revision, uptime, database health, active or stale code-update tasks, agent task metrics, and recent tasks. Use after deploys or when users ask whether the deployed bot is healthy or whether codegen is stuck.",
    userVisible: true,
    mutates: false,
    group: "ops",
    category: "ops",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getSpendSummary",
    toolClass: "ops",
    examples: ["@ai how much have we spent today?"],
    description:
      "Report estimated model/tool spend for this Discord guild from tool audit logs. Use when ops users ask how much the bot has spent today or this month, or which tools/users drove spend.",
    userVisible: true,
    mutates: false,
    group: "ops",
    category: "ops",
    outputContract: ["total estimated spend", "top tools by spend", "top users by spend", "period"],
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "month"], description: "Spend period. Defaults to today." },
        limit: { type: "number", description: "Maximum rows per breakdown. Defaults to 10." }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "inspectAgentLogs",
    toolClass: "ops",
    description:
      "Inspect Discord AI Agent's own normalized run diagnostics, model rounds, prompt composition, critical path, trace events, task events, terminal command events, and tool audit logs for debugging slow, failed, hung, or confusing bot behavior. When the user is replying to the run or bot response, omit traceId to resolve the reply chain automatically. Use detail=model_io only when the user explicitly asks to inspect the exact model input, output, or prompt; returned excerpts are permission-filtered, secret-redacted, and bounded.",
    userVisible: true,
    mutates: false,
    group: "ops",
    category: "ops",
    outputContract: [
      "resolved requester-visible run reference",
      "model-round, prompt-composition, and critical-path diagnosis",
      "bounded secret-redacted model input/output when explicitly requested",
      "recent trace, task, command, and tool evidence",
    ],
    permissionRequirements: ["owner_or_authorized_debugger", "requester_visible_discord_channels", "tool_audit_log"],
    auditEvents: ["tool_audit_logs", "trace_events"],
    examples: ["@ai why did that last answer fail?", "@ai debug this", "@ai show me the exact prompt you received"],
    parameters: {
      type: "object",
      properties: {
        traceId: {
          type: "string",
          description: "Optional trace ID, run ID, originating Discord message ID, or Discord message URL to inspect."
        },
        limit: {
          type: "number",
          description: "Maximum trace events and tool logs to return. Defaults to 20."
        },
        detail: {
          type: "string",
          enum: ["summary", "model_io"],
          description: "Use summary for normal debugging. Use model_io only for an explicit request to inspect bounded redacted model input/output."
        }
      },
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
