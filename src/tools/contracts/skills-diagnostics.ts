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
