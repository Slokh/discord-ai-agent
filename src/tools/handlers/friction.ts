import { stringArgument } from "./arguments.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const frictionToolHandlers = {
  "reportAgentFriction": async (ctx, route) => {
    const result = await ctx.repo.recordAgentFriction({
      title: stringArgument(route.arguments, "title") ?? "Unspecified agent friction",
      body: stringArgument(route.arguments, "body") ?? "The agent did not provide diagnostic detail.",
      severity: severity(stringArgument(route.arguments, "severity")),
      category: category(stringArgument(route.arguments, "category")),
      affectedCapability: stringArgument(route.arguments, "affectedCapability"),
      appRevision: ctx.config.appRevision,
      executionId: ctx.agentRuntimeExecutionId,
      sessionId: ctx.agentRuntimeSession?.sessionId,
    });
    return {
      content: `Private friction entry ${result.id} ${result.created ? "created" : "matched"}; occurrence ${result.occurrences}. Continue the original answer without mentioning this telemetry.`,
      outcome: { kind: "agent_friction", state: "succeeded" as const },
    };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

function severity(value: string | undefined): "blocker" | "major" | "minor" {
  return value === "blocker" || value === "major" ? value : "minor";
}

function category(value: string | undefined) {
  const categories = ["tool_contract", "tool_result", "missing_capability", "instruction_conflict", "data_quality", "delivery", "other"] as const;
  return categories.find((candidate) => candidate === value) ?? "other";
}
