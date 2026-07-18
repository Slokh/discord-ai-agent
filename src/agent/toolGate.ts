import { toolRegistry, type ToolName } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

/**
 * Permission and daily-budget gating for restricted model-facing tools,
 * applied by the dispatcher before any tool implementation runs.
 */

const RESTRICTED_TOOL_MESSAGES: Partial<Record<ToolName, string>> = {
  runCodingAgent: "Code-update tasks are restricted to the bot owner or codegen allowlist.",
  retryAgentTask: "Retrying code-update tasks is restricted to the bot owner or codegen allowlist.",
  updateBotAvatar: "Avatar updates are restricted to the bot owner or ops allowlist.",
  createDiscordEmoji: "Server emoji uploads are restricted to the bot owner or ops allowlist.",
  setUserTurnLimit: "User turn limits are restricted to the bot owner or ops allowlist.",
  reconcileWalletTransfers: "Wallet reconciliation is restricted to the bot owner or ops allowlist.",
  adminTransferWalletFunds: "Wallet administration is restricted to the bot owner or ops allowlist.",
  generateImage: "Image generation is restricted to the bot owner or configured allowlist."
};

export type ToolGateDecision = { allowed: true } | { allowed: false; message: string };

export async function restrictedToolGate(ctx: ToolContext, toolName: ToolName): Promise<ToolGateDecision> {
  if (ctx.mutationAuthorizedByCurrentInput === false && toolRegistry.find((tool) => tool.name === toolName)?.mutates) {
    return { allowed: false, message: "This component follow-up cannot authorize a mutating action. Ask the user to state that action explicitly in a new Discord message." };
  }
  if (toolName === "runCodingAgent" || toolName === "retryAgentTask") {
    if (!isAllowed(ctx, ctx.config.allowlists?.codegenUserIds ?? [])) return denied(toolName);
    const limit = ctx.config.budget?.userCodegenPerDay ?? -1;
    if (limit >= 0 && ctx.budgetRepo) {
      const count = await ctx.budgetRepo.countUserCodegenTasksSince({ guildId: ctx.guildId, userId: ctx.userId, since: startOfUtcDay(new Date()) });
      if (count >= limit) return { allowed: false, message: "You've hit today's code-update task limit. Try again tomorrow." };
    }
  }
  if (toolName === "updateBotAvatar" && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  if (toolName === "createDiscordEmoji" && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  if (toolName === "setUserTurnLimit" && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
  if ((toolName === "reconcileWalletTransfers" || toolName === "adminTransferWalletFunds") && !isStrictlyAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) {
    return denied(toolName);
  }
  if (toolName === "generateImage") {
    if (ctx.config.allowlists?.imageToolsAllowlistOnly && !isAllowed(ctx, ctx.config.allowlists?.opsUserIds ?? [])) return denied(toolName);
    const limit = ctx.config.budget?.userImagesPerDay ?? -1;
    if (limit >= 0 && ctx.budgetRepo) {
      const count = await ctx.budgetRepo.countUserToolCallsSince({ guildId: ctx.guildId, userId: ctx.userId, toolName: "generateImage", since: startOfUtcDay(new Date()) });
      if (count >= limit) return { allowed: false, message: "You've hit today's image generation limit. Try again tomorrow." };
    }
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

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
