import { paymentRecorder } from "./paymentToolContext.js";
import { currentWagerForContext } from "./randomTools.js";
import type { ToolContext } from "./types.js";

const SUCCESS_PREFIX = "Wallet game paused for player action.";
const MAX_STATE_BYTES = 12 * 1024;
const MAX_ACTIONS = 12;

export async function awaitRandomWagerAction(ctx: ToolContext, input: {
  wagerId?: string;
  expectedVersion?: number;
  state?: Record<string, unknown>;
  allowedActions?: string[];
  prompt?: string;
}): Promise<string> {
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return "Wallet-backed game sessions are not enabled in this deployment.";
  }
  const requestId = ctx.requestId ?? ctx.requestMessageId;
  const prompt = input.prompt?.trim();
  if (!requestId) return "A stable Discord request id is required to save game state.";
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion! < 0) {
    return "expectedVersion must be the non-negative state version from the active wager.";
  }
  if (!input.state || typeof input.state !== "object" || Array.isArray(input.state)) {
    return "state must be a JSON object containing everything needed to continue the game.";
  }
  if (Buffer.byteLength(JSON.stringify(input.state), "utf8") > MAX_STATE_BYTES) {
    return `state must be at most ${MAX_STATE_BYTES} bytes.`;
  }
  const allowedActions = normalizeActions(input.allowedActions);
  if (allowedActions.length === 0) return "allowedActions must contain at least one distinct player action.";
  if (allowedActions.some(isSettlementConfirmation)) {
    return "allowedActions must be genuine gameplay decisions, not confirmation or settlement. Call settleRandomWager immediately when the outcome is already final.";
  }
  if (!prompt) return "prompt is required and must ask the player for their next decision.";

  const wager = await currentWagerForContext(ctx);
  if (!wager) return "Could not pause wallet game: no active wager exists for this player in this Discord game session.";
  const suppliedWagerId = input.wagerId?.trim();
  if (suppliedWagerId && suppliedWagerId !== wager.id) {
    await paymentRecorder(ctx)({
      eventName: "wallet.wager.id_hint_corrected",
      summary: "Ignored a stale or malformed model-supplied wager id and used the scoped active wager",
      level: "warn",
      metadata: { suppliedWagerId, resolvedWagerId: wager.id }
    });
  }

  try {
    const updated = await ctx.walletService.awaitGameAction({
      wagerId: wager.id,
      userId: ctx.userId,
      requestId,
      expectedVersion: input.expectedVersion!,
      state: input.state,
      allowedActions,
      prompt
    }, paymentRecorder(ctx));
    return [
      SUCCESS_PREFIX,
      `Game: ${updated.game}`,
      `State version: ${updated.stateVersion}`,
      `Allowed actions: ${updated.allowedActions.join(", ")}`,
      `Prompt: ${updated.actionPrompt}`,
      `The wager remains reserved until the player replies, settlement succeeds, or the session expires.`
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not pause wallet game: ${message}`;
  }
}

export function isSuccessfulAwaitRandomWagerAction(content: string) {
  return content.trimStart().startsWith(SUCCESS_PREFIX);
}

function normalizeActions(actions: string[] | undefined) {
  const normalized = (actions ?? [])
    .map((action) => action.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((action) => action.length > 0 && action.length <= 80);
  return [...new Set(normalized)].slice(0, MAX_ACTIONS);
}

function isSettlementConfirmation(action: string) {
  return /^(?:confirm|settle|resolve|accept|acknowledge)(?:\s+(?:the\s+)?(?:result|outcome|wager|bet|game|settlement|payout|win|loss|to\s+settle))?$/i.test(action);
}
