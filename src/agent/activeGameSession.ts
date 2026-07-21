import type { ChatMessage } from "../models/openrouter.js";
import { atomicToUsd } from "../payments/money.js";
import type { WagerReservation } from "../payments/types.js";
import { wagerThreadKeyForContext } from "../tools/randomTools.js";
import type { ToolContext } from "../tools/types.js";

export type ActiveGameSessionContext = {
  wager: WagerReservation;
  actionRequested: boolean;
};

export async function loadActiveGameSession(
  ctx: ToolContext,
  userText: string
): Promise<ActiveGameSessionContext | null> {
  if (!ctx.config.payments?.userWalletsEnabled || !ctx.walletService) return null;
  const threadKey = wagerThreadKeyForContext(ctx);
  if (!threadKey) return null;
  const threadKeyPrefix = ctx.threadKey?.trim() ? `${ctx.threadKey.trim()}:rng-root:` : undefined;
  const replyMessageIds = ctx.replyContext?.chain.map((message) => message.messageId) ?? [];
  const wager = await ctx.walletService.getActiveGameSession({
    threadKey,
    userId: ctx.userId,
    threadKeyPrefix,
    replyMessageIds,
  });
  if (!wager) return null;
  return { wager, actionRequested: matchesAllowedAction(userText, wager.allowedActions) };
}

export function injectActiveGameSession(
  messages: ChatMessage[],
  active: ActiveGameSessionContext | null
) {
  if (!active) return;
  const wager = active.wager;
  const state = JSON.stringify(wager.decisionState);
  const content = [
    "An active wallet-backed game is awaiting this requester's decision in this Discord reply chain.",
    `Game: ${wager.game}`,
    `Stake: $${atomicToUsd(wager.stakeAtomic, wager.tokenDecimals)} USD`,
    `Maximum total payout: $${atomicToUsd(wager.maxPayoutAtomic, wager.tokenDecimals)} USD`,
    `State version: ${wager.stateVersion}`,
    `Allowed actions: ${wager.allowedActions.join(", ")}`,
    `Saved state: ${state}`,
    wager.actionPrompt ? `Pending prompt: ${wager.actionPrompt}` : null,
    "Treat the latest user message as the only new input. If it selects an allowed action, apply exactly that action to the saved state. Use drawRandom without a new wager only if that action needs additional chance, then either call awaitRandomWagerAction with the updated complete state and current version or call settleRandomWager for a final outcome using resolutionSource=player_decision. Never reserve a second wager for this game. If the message is a question or does not choose an allowed action, answer conversationally without changing state."
  ].filter((line): line is string => line !== null).join("\n");
  messages.splice(Math.max(0, messages.length - 1), 0, { role: "system", content });
}

function matchesAllowedAction(text: string, actions: string[]) {
  const normalized = text.trim().toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ");
  return actions.some((action) => {
    const candidate = action.trim().toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ");
    if (!candidate) return false;
    return normalized === candidate || new RegExp(`(?:^|\\s)${escapeRegex(candidate)}(?:$|\\s)`, "i").test(normalized);
  });
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
