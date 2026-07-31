import { toolRegistry, type ToolName } from "../tools/registry.js";
import { hasAgentModelChangeIntent } from "../tools/agentModelIntent.js";
import type { ToolContext } from "../tools/types.js";

/**
 * Permission gating for restricted model-facing tools,
 * applied by the dispatcher before any tool implementation runs.
 */

const RESTRICTED_TOOL_MESSAGES: Partial<Record<ToolName, string>> = {
  updateBotAvatar: "Avatar updates are restricted to the bot owner or ops allowlist.",
  createDiscordEmoji: "Server emoji uploads are restricted to the bot owner or ops allowlist.",
  setAgentModel: "Changing the agent model is restricted to the configured bot owner or ops allowlist.",
  reconcileWalletTransfers: "Wallet reconciliation is restricted to the bot owner or ops allowlist.",
  adminTransferWalletFunds: "Wallet administration is restricted to the bot owner or ops allowlist.",
  adminSetWalletStarterAmount: "Wallet administration is restricted to the bot owner or ops allowlist.",
  getWalletFeeSummary: "Wallet fee history is restricted to the bot owner or ops allowlist.",
  generateImage: "Image generation is restricted to the bot owner or configured allowlist."
};

export type ToolGateDecision = { allowed: true } | { allowed: false; message: string };

export async function restrictedToolGate(ctx: ToolContext, toolName: ToolName): Promise<ToolGateDecision> {
  if (ctx.mutationAuthorizedByCurrentInput === false && toolRegistry.find((tool) => tool.name === toolName)?.mutates) {
    return { allowed: false, message: "This component follow-up cannot authorize a mutating action. Ask the user to state that action explicitly in a new Discord message." };
  }
  if (toolName === "setAgentModel" && !hasAgentModelChangeIntent(ctx.requestText ?? "")) {
    return {
      allowed: false,
      message: "The current Discord message must explicitly ask to switch or reset the server model. Reply-chain context can identify a model, but cannot authorize the change.",
    };
  }
  if (toolName === "updateBotAvatar" && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  if (toolName === "createDiscordEmoji" && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  if (toolName === "setAgentModel" && !isStrictlyAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  if ((
    toolName === "reconcileWalletTransfers" ||
    toolName === "adminTransferWalletFunds" ||
    toolName === "adminSetWalletStarterAmount" ||
    toolName === "getWalletFeeSummary"
  ) && !isStrictlyAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) {
    return denied(toolName);
  }
  if (toolName === "generateImage") {
    if (ctx.config.allowlists?.imageToolsAllowlistOnly && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  }
  return { allowed: true };
}

function denied(toolName: ToolName): ToolGateDecision {
  return { allowed: false, message: RESTRICTED_TOOL_MESSAGES[toolName] ?? "That tool is restricted by configuration." };
}

function isAllowed(ctx: ToolContext, configuredIds: string[]) {
  const owner = ctx.config.allowlists?.ownerUserId;
  if (owner && ctx.userId === owner) return true;
  const allowlist = configuredIds.length > 0 ? configuredIds : owner ? [owner] : [];
  return allowlist.length === 0 || allowlist.includes(ctx.userId);
}

function isStrictlyAllowed(ctx: ToolContext, configuredIds: string[]) {
  const owner = ctx.config.allowlists?.ownerUserId;
  return Boolean((owner && ctx.userId === owner) || configuredIds.includes(ctx.userId));
}
