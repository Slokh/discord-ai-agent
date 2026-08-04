import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const skillDiagnosticToolContracts = [
  defineTool({
    name: "getDeploymentStatus",
    toolClass: "ops",
    examples: ["@ai deployment status"],
    description:
      "Report the running deployment revision, uptime, database health, active or stale code-update tasks, agent task metrics, and recent tasks. Use after deploys or when users ask whether the deployed bot is healthy or whether codegen is stuck.",
    mutates: false,
    group: "ops",
    accessPolicy: "strict_ops",
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
    mutates: false,
    group: "ops",
    accessPolicy: "strict_ops",
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

] satisfies ToolRegistryEntry[];
