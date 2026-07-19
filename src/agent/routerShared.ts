import type { ToolContext } from "../tools/types.js";
import type { ToolName } from "../tools/registry.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export type AgentToolRoute = {
  id: string;
  name: ToolName;
  arguments?: Record<string, unknown>;
  argumentsText: string;
  /** True when a schema-directed, semantics-preserving argument repair was applied. */
  argumentsNormalized?: boolean;
};

export type ModelCallBudget = {
  used: number;
  ceiling: number;
  tripped: boolean;
};

export const MAX_TOOL_ROUNDS = 4;
export const MAX_MODEL_CALLS_PER_TURN = MAX_TOOL_ROUNDS + 1;

export async function reserveModelCall(
  ctx: ToolContext,
  budget: ModelCallBudget,
  callKind: string,
  metadata: Record<string, unknown> = {},
) {
  if (budget.used >= budget.ceiling) {
    if (!budget.tripped) {
      budget.tripped = true;
      await recordAgentEvent(ctx, {
        eventName: "agent.model_call_ceiling",
        level: "warn",
        summary: `Stopped before ${callKind}; model call ceiling ${budget.ceiling} reached`,
        metadata: {
          callKind,
          used: budget.used,
          ceiling: budget.ceiling,
          ...metadata,
        },
      });
    }
    return false;
  }
  budget.used += 1;
  return true;
}

export function cleanFinalModelResponse(content: string) {
  return content.trim() || "Done.";
}
