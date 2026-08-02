import type { ChatMessage } from "../models/openrouter.js";
import { atomicToUsd } from "../payments/money.js";
import type { WagerReservation } from "../payments/types.js";
import { wagerThreadKeyForContext } from "../tools/randomTools.js";
import type { ToolContext } from "../tools/types.js";
import { insertInitialSystemContext } from "./promptBuilder.js";

export type ActiveGameSessionContext = {
  wager: WagerReservation;
};

export async function loadActiveGameSession(
  ctx: ToolContext,
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
  return { wager };
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
    "This is context, not an instruction to continue the game. Decide from the latest user message whether they are choosing an allowed action, asking about the game, or starting another task. Only a typed game tool call changes state. If they choose an action, apply that meaning to the saved state even when phrased conversationally. Use drawRandom without a new wager only if that action needs additional chance, then either call awaitRandomWagerAction with the updated complete state and current version or call settleRandomWager for a final outcome using resolutionSource=player_decision. Never reserve a second wager for this game. If the message is a question or does not choose an allowed action, answer without changing state."
  ].filter((line): line is string => line !== null).join("\n");
  insertInitialSystemContext(messages, content);
}
