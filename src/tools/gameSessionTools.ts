import { paymentRecorder } from "./paymentToolContext.js";
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
  const wagerId = input.wagerId?.trim();
  const requestId = ctx.requestId ?? ctx.requestMessageId;
  const prompt = input.prompt?.trim();
  if (!wagerId) return "wagerId is required.";
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
  if (!prompt) return "prompt is required and must ask the player for their next decision.";

  try {
    const wager = await ctx.walletService.awaitGameAction({
      wagerId,
      userId: ctx.userId,
      requestId,
      expectedVersion: input.expectedVersion!,
      state: input.state,
      allowedActions,
      prompt
    }, paymentRecorder(ctx));
    return [
      SUCCESS_PREFIX,
      `Wager: ${wager.id}`,
      `Game: ${wager.game}`,
      `State version: ${wager.stateVersion}`,
      `Allowed actions: ${wager.allowedActions.join(", ")}`,
      `Prompt: ${wager.actionPrompt}`,
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
