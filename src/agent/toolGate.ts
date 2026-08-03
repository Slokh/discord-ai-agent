import { toolByName, type ToolName } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

/**
 * Permission gating for restricted model-facing tools,
 * applied by the dispatcher before any tool implementation runs.
 */

export type ToolGateDecision = { allowed: true } | { allowed: false; message: string };

export async function restrictedToolGate(ctx: ToolContext, toolName: ToolName): Promise<ToolGateDecision> {
  const tool = toolByName(toolName);
  if (tool?.mutates && ctx.mutationAuthorizedByCurrentInput !== true) {
    return { allowed: false, message: "This input cannot authorize a mutating action because explicit current-message authority is missing. Ask the user to state that action in a new Discord message." };
  }
  const opsIds = ctx.config.allowlists?.opsUserIds ?? [];
  if (tool?.accessPolicy === "strict_ops" && !isStrictlyAllowed(ctx, opsIds)) return denied();
  return { allowed: true };
}

function denied(message?: string): ToolGateDecision {
  return {
    allowed: false,
    message: message ?? "That action is restricted to the configured bot owner or ops allowlist.",
  };
}

function isStrictlyAllowed(ctx: ToolContext, configuredIds: string[]) {
  const owner = ctx.config.allowlists?.ownerUserId;
  return Boolean((owner && ctx.userId === owner) || configuredIds.includes(ctx.userId));
}
