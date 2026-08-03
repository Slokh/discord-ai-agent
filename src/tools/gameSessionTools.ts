import { paymentRecorder } from "./paymentToolContext.js";
import { currentWagerForContext } from "./randomTools.js";
import type { AgentResponse, ToolContext } from "./types.js";

const MAX_STATE_BYTES = 12 * 1024;
const MAX_ACTIONS = 12;

export async function awaitRandomWagerAction(ctx: ToolContext, input: {
  wagerId?: string;
  expectedVersion?: number;
  state?: Record<string, unknown>;
  allowedActions?: string[];
  prompt?: string;
}): Promise<AgentResponse> {
  if (!ctx.config.payments.userWalletsEnabled || !ctx.walletService) {
    return gameSessionError("not_configured", "Wallet-backed game sessions are not enabled in this deployment.");
  }
  const requestId = ctx.requestId ?? ctx.requestMessageId;
  const prompt = input.prompt?.trim();
  if (!requestId) return gameSessionError("missing_request_id", "A stable Discord request id is required to save game state.");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion! < 0) {
    return gameSessionError("invalid_state_version", "expectedVersion must be the non-negative state version from the active wager.");
  }
  if (!input.state || typeof input.state !== "object" || Array.isArray(input.state)) {
    return gameSessionError("invalid_game_state", "state must be a JSON object containing everything needed to continue the game.");
  }
  if (Buffer.byteLength(JSON.stringify(input.state), "utf8") > MAX_STATE_BYTES) {
    return gameSessionError("game_state_too_large", `state must be at most ${MAX_STATE_BYTES} bytes.`);
  }
  const allowedActions = normalizeActions(input.allowedActions);
  if (allowedActions.length === 0) return gameSessionError("missing_allowed_actions", "allowedActions must contain at least one distinct player action.");
  if (!prompt) return gameSessionError("missing_action_prompt", "prompt is required and must ask the player for their next decision.");

  const wager = await currentWagerForContext(ctx);
  if (!wager) return gameSessionError("active_wager_not_found", "Could not pause wallet game: no active wager exists for this player in this Discord game session.");
  if (
    wager.game.trim().toLowerCase() === "blackjack" &&
    allowedActions.some((action) => action !== "hit" && action !== "stand")
  ) {
    return gameSessionError("unsupported_blackjack_action", "Could not pause wallet game: standard blackjack currently supports only hit and stand so settlement remains deterministic.");
  }
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
    return {
      content: [
      "Wallet game paused for player action.",
      `Game: ${updated.game}`,
      `State version: ${updated.stateVersion}`,
      `Allowed actions: ${updated.allowedActions.join(", ")}`,
      `Prompt: ${updated.actionPrompt}`,
      `The wager remains reserved until the player replies, settlement succeeds, or the session expires.`
      ].join("\n"),
      status: "ok",
      outcome: { kind: "wager", state: "awaiting_action", terminal: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return gameSessionError("game_session_update_failed", `Could not pause wallet game: ${message}`, true);
  }
}

function gameSessionError(errorCode: string, content: string, retryable = false): AgentResponse {
  return {
    content,
    status: "error",
    errorCode,
    retryable,
    outcome: { kind: "wager", state: "failed" },
  };
}

function normalizeActions(actions: string[] | undefined) {
  const normalized = (actions ?? [])
    .map((action) => action.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((action) => action.length > 0 && action.length <= 80);
  return [...new Set(normalized)].slice(0, MAX_ACTIONS);
}
