import type { RngRepository, RngSessionTx } from "../db/rngRepository.js";
import {
  CARDS_PER_DECK,
  MAX_DECK_COUNT,
  computeRngOutcome,
  deckCardsAt,
  formatRngOutcome,
  generateServerSeed,
  rngCommitment,
  verifyRngCommitment,
  type RngDrawKind,
  type RngDrawParams
} from "../rng/provable.js";
import { summarizeForAudit } from "../util/text.js";
import { atomicToUsd } from "../payments/money.js";
import type {
  WagerInteractionMode,
  WagerReservation,
  WagerResolutionSource,
  WagerSettlementOutcome
} from "../payments/types.js";
import { paymentRecorder } from "./paymentToolContext.js";
import type { AgentResponse, ToolContext } from "./types.js";
import { isPaymentDomainError } from "../payments/errors.js";
import { ensureAgentTurnOutput } from "./turnOutput.js";
import { validateWagerFairness } from "./wagerFairness.js";
import { wagerRequester } from "./wagerRequesterScope.js";
import { effectiveMaximumPayoutUsd } from "./wagerTerms.js";
import { normalizeDrawRandomInput, validateDrawInput, validateWagerInput } from "./randomInputValidation.js";
import type { DrawRandomInput } from "./randomTypes.js";
import {
  isStandardWagerGame,
  prepareStandardWagerSettlement,
  type WagerSettlementProposal,
} from "./standardWagerRuntime.js";

const MAX_FOOTER_OUTCOME_CHARS = 160;
const MAX_REVEAL_DRAW_LINES = 25;
const RNG_ROOT_SCOPE_SEGMENT = "rng-root";
const DRAW_KINDS = new Set(["integers", "dice", "coin", "pick", "shuffle", "cards"]);

export async function drawRandom(ctx: ToolContext, input: DrawRandomInput): Promise<string> {
  return drawRandomCore(ctx, input);
}

async function drawRandomCore(
  ctx: ToolContext,
  input: DrawRandomInput,
  knownContinuingWager?: WagerReservation | null,
  onDrawn?: (result: { wagerActive: boolean }) => void,
): Promise<string> {
  input = normalizeDrawRandomInput(input);
  let continuingWager = knownContinuingWager ?? null;
  if (knownContinuingWager === undefined && ctx.config.payments.userWalletsEnabled && ctx.walletService) {
    continuingWager = await currentWagerForContext(ctx);
  }
  const continuationError = validateWagerContinuation(continuingWager, input);
  if (continuationError) {
    await auditRng(ctx, "drawRandom", input, continuationError);
    return continuationError;
  }
  const kind = (input.kind ?? "").trim();
  if (!DRAW_KINDS.has(kind)) {
    await auditRng(ctx, "drawRandom", input, `unknown kind "${kind}"`);
    return `Unknown draw kind "${kind}". Supported kinds: integers, dice, coin, pick, shuffle, cards.`;
  }
  const setup = await ensureRngSetup(ctx, "drawRandom", input);
  if (typeof setup === "string") return setup;
  const { rngRepo, threadKey } = setup;

  const validationError = validateDrawInput(kind, input);
  if (validationError) {
    await auditRng(ctx, "drawRandom", input, validationError);
    return validationError;
  }

  const wagerValidationError = validateWagerInput(input);
  if (wagerValidationError) {
    await auditRng(ctx, "drawRandom", input, wagerValidationError);
    return wagerValidationError;
  }
  if (input.wager && !ctx.config.payments.userWalletsEnabled) {
    return "User wallets and wallet-backed wagers are not enabled in this deployment.";
  }
  if (input.wager && !ctx.walletService) {
    return "Wallet-backed wagers are not enabled in this deployment.";
  }
  const requester = input.wager ? wagerRequester(ctx) : null;
  if (typeof requester === "string") {
    await auditRng(ctx, "drawRandom", input, requester);
    return requester;
  }
  const effectiveMaxPayoutUsd = input.wager
    ? effectiveMaximumPayoutUsd({
        game: input.wager.game!,
        stakeUsd: input.wager.stakeUsd!,
        requestedMaxPayoutUsd: input.wager.maxPayoutUsd!,
      })
    : null;
  if (input.wager) {
    if (input.wager.playerUserId !== requester!.userId) {
      const error = input.wager.playerUserId
        ? `Wager rejected: playerUserId ${input.wager.playerUserId} does not match the current requester ${requester!.userId}. A user may only risk their own wallet; no funds were reserved and no random draw was made.`
        : `Wager rejected: wager.playerUserId is required and must be the current requester ${requester!.userId}. A user may only risk their own wallet; no funds were reserved and no random draw was made.`;
      await auditRng(ctx, "drawRandom", input, error);
      return error;
    }
  }
  if (input.wager && (input.wager.rule || ["coin", "dice", "integers"].includes(kind))) {
    const fairnessError = validateWagerFairness({
      kind,
      count: input.count,
      sides: input.sides,
      min: input.min,
      max: input.max,
      stakeUsd: input.wager.stakeUsd!,
      maxPayoutUsd: effectiveMaxPayoutUsd!,
      rule: input.wager.rule,
    });
    if (fairnessError) {
      await auditRng(ctx, "drawRandom", input, fairnessError);
      return fairnessError;
    }
  }
  let wager: WagerReservation | null = null;
  let wagerInteractionMode: WagerInteractionMode | null = null;
  if (input.wager) {
    const requestId = ctx.requestId ?? ctx.requestMessageId;
    if (!requestId) return "A stable request id is required before a wallet-backed wager can be reserved.";
    try {
      wagerInteractionMode = input.wager.interactionMode!;
      wager = await ctx.walletService!.reserveWager(
        {
          requestId,
          guildId: ctx.guildId,
          channelId: ctx.channelId,
          threadKey,
          userId: requester!.userId,
          game: input.wager.game!.trim(),
          interactionMode: wagerInteractionMode,
          stakeUsd: input.wager.stakeUsd!,
          maxPayoutUsd: effectiveMaxPayoutUsd!
        },
        paymentRecorder(ctx)
      );
    } catch (error) {
      if (isPaymentDomainError(error) && error.code === "wager_already_exists") {
        const result = "A wallet-backed wager has already been reserved for this Discord request. Use the first successful draw and settle that wager; do not draw or reserve another wager.";
        await auditRng(ctx, "drawRandom", input, result);
        return result;
      }
      if (isPaymentDomainError(error) && error.code === "active_game_exists") {
        const result = "An active wallet-backed game already exists in this Discord reply chain. Continue that game from its saved state or settle it before starting another wager.";
        await auditRng(ctx, "drawRandom", input, result);
        return result;
      }
      if (isPaymentDomainError(error) && error.code === "insufficient_user_balance") {
        const result = "The wager could not be reserved because the user's available wallet balance is below the requested stake. Available balance excludes active wager and transfer reservations; gas fees are paid by the bot fee payer and are not deducted from the user.";
        await auditRng(ctx, "drawRandom", input, result);
        return result;
      }
      if (isPaymentDomainError(error) && error.code === "insufficient_bot_coverage") {
        const result = "The wager could not be reserved because the bot wallet cannot currently cover the maximum payout. No funds were reserved and no random draw was made. Try a smaller stake or lower-payout game.";
        await auditRng(ctx, "drawRandom", input, result);
        return result;
      }
      throw error;
    }
  }

  const clientSeedValue = ctx.requestMessageId ?? ctx.requestId ?? generateServerSeed();
  const clientSeedSource = ctx.requestMessageId ? "discord_message_id" : ctx.requestId ? "request_id" : "random";
  const reason = input.wagerAction
    ? `blackjack:${input.wagerAction}`
    : input.wager?.rule?.kind === "coin_side"
      ? `coin:${input.wager.rule.side}`
      : normalizeReason(input.reason);
  // Candidate seed for a new session; discarded unpublished when one already exists.
  const candidateServerSeed = generateServerSeed();

  let result: DrawTxResult;
  try {
    result = await rngRepo.withActiveSession<DrawTxResult>(
    {
      threadKey,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      createdByUserId: ctx.userId,
      serverSeed: candidateServerSeed,
      commitment: rngCommitment(candidateServerSeed)
    },
    async (tx, sessionCreated) => {
      // Validate against session state before consuming the client seed or entropy.
      if (kind === "cards") {
        const deckCount = input.deckCount ?? tx.session.deckCount ?? 1;
        const maxSize = deckCount * CARDS_PER_DECK;
        if ((input.count ?? 1) > maxSize) {
          return {
            ok: false,
            error: `Cannot draw ${input.count} cards from a ${deckCount}-deck shoe of ${maxSize} cards. Use a larger deckCount (up to ${MAX_DECK_COUNT}).`
          };
        }
      }
      const seed = await tx.setClientSeed(clientSeedValue, clientSeedSource);
      const draw =
        kind === "cards"
          ? await drawCards(tx, ctx, seed.clientSeed, input, reason)
          : await drawBasic(tx, ctx, seed.clientSeed, kind as RngDrawKind, input, reason);
      return {
        ok: true,
        draw,
        sessionId: tx.session.id,
        commitment: tx.session.commitment,
        clientSeed: seed.clientSeed,
        showCommit: sessionCreated || seed.justSet
      };
    }
    );
  } catch (error) {
    if (wager && ctx.walletService) await ctx.walletService.releaseWager(wager.id, "RNG draw failed", paymentRecorder(ctx));
    throw error;
  }

  if (!result.ok) {
    if (wager && ctx.walletService) await ctx.walletService.releaseWager(wager.id, result.error, paymentRecorder(ctx));
    await auditRng(ctx, "drawRandom", input, result.error);
    return result.error;
  }
  const { draw, sessionId, commitment, clientSeed, showCommit } = result;
  if (wager && ctx.walletService) {
    try {
      await ctx.walletService.attachWagerDraw(wager.id, draw.drawId, paymentRecorder(ctx));
    } catch (error) {
      await ctx.walletService.releaseWager(wager.id, "Could not attach the RNG draw", paymentRecorder(ctx));
      throw error;
    }
  }

  const footerLines: string[] = [];
  if (draw.shuffleFooter) footerLines.push(draw.shuffleFooter);
  footerLines.push(draw.footerLine);
  if (showCommit) {
    footerLines.push(
      `🎲 fair-play commit sha256:${commitment} · client seed ${clientSeed} · reply "reveal randomness" to verify`
    );
  }
  ensureAgentTurnOutput(ctx).addFooterLines(...footerLines);
  onDrawn?.({ wagerActive: Boolean(wager || continuingWager) });

  await auditRng(ctx, "drawRandom", input, `session ${sessionId} nonce ${draw.nonce}: ${draw.summary}`).catch(() => undefined);

  return [
    `Provably fair draw complete.`,
    `Result: ${draw.summary}`,
    `Session ${sessionId} · nonce ${draw.nonce} · draw ${draw.drawId} · commitment sha256:${commitment}`,
    wager
      ? wagerInteractionMode === "player_decisions"
        ? `The scoped wallet wager is reserved for the current requester ${ctx.requesterScope?.userDisplayName ?? ctx.userDisplayName} (Discord user ${ctx.requesterScope?.userId ?? ctx.userId}); never attribute it to another person. Maximum total payout reserved: $${effectiveMaxPayoutUsd}.\nRequired next action: if this verified draw already makes the outcome final with no player choice, call settleRandomWager now with resolutionSource=verified_randomness. Otherwise call awaitRandomWagerAction with complete versioned game state and genuine gameplay choices. Never pause a terminal outcome or invent confirm/settle as a player action. Do not draw again or answer before one of those tools succeeds. The runtime resolves the wager from this Discord game session; do not supply or repeat an internal wager id.`
        : `The scoped wallet wager is reserved for the current requester ${ctx.requesterScope?.userDisplayName ?? ctx.userDisplayName} (Discord user ${ctx.requesterScope?.userId ?? ctx.userId}); never attribute it to another person. Maximum total payout reserved: $${effectiveMaxPayoutUsd}.\nRequired next action: if the outcome is final, call settleRandomWager now. If the rules require more automatic chance before the outcome is final, call drawRandom again without a new wager. If a genuine player choice is required, call awaitRandomWagerAction. Do not answer until one of these tools succeeds. The runtime resolves the wager from this Discord game session; do not supply or repeat an internal wager id.`
      : continuingWager
        ? `This verified draw continues the scoped active wallet wager. If more automatic chance is required, call drawRandom again without a new wager. If a genuine player decision is needed, save the updated state with awaitRandomWagerAction. When the outcome is final, call settleRandomWager exactly once before answering.`
        : null,
    `Report this result exactly as shown. A proof footer is appended to your reply automatically; do not restate or alter the proof details.`
  ].filter((line): line is string => line !== null).join("\n");
}

/**
 * Runtime-facing draw result. It owns mutation outcome metadata so the caller
 * never has to infer success from prose or perform a fallible post-draw read.
 */
export async function drawRandomResponse(ctx: ToolContext, input: DrawRandomInput): Promise<AgentResponse> {
  const continuingWager = ctx.config.payments.userWalletsEnabled && ctx.walletService
    ? await currentWagerForContext(ctx)
    : null;
  let drawResult: { wagerActive: boolean } | undefined;
  const content = await drawRandomCore(ctx, input, continuingWager, (result) => { drawResult = result; });
  const succeeded = Boolean(drawResult);
  const wagerActive = drawResult?.wagerActive ?? false;
  return {
    content,
    status: succeeded ? "ok" : "error",
    retryable: !succeeded,
    outcome: {
      kind: "rng_draw",
      state: succeeded ? "succeeded" : "failed",
      wagerActive,
      terminal: succeeded && !wagerActive,
    },
  };
}

function validateWagerContinuation(wager: WagerReservation | null, input: DrawRandomInput): string | null {
  if (!wager) {
    return input.wagerAction
      ? "wagerAction is only valid while continuing an active blackjack wager. No random draw was made."
      : null;
  }
  if (input.wager) {
    return "An active wallet-backed game already exists in this Discord reply chain. Continue its saved state without supplying a new wager. No random draw was made."
  }
  if (wager.game.trim().toLowerCase() !== "blackjack") return null;
  if (input.wagerAction !== "hit" && input.wagerAction !== "stand") {
    return "Continuing blackjack requires wagerAction=hit or wagerAction=stand from the saved game state. No random draw was made."
  }
  if (!wager.allowedActions.includes(input.wagerAction)) {
    return `The saved blackjack game does not allow ${input.wagerAction}; allowed actions are ${wager.allowedActions.join(", ") || "none"}. No random draw was made.`;
  }
  if (input.kind !== "cards" || (input.count ?? 1) !== 1) {
    return "A blackjack continuation must draw exactly one card with kind=cards and count=1. No random draw was made."
  }
  return null;
}

export async function settleRandomWager(
  ctx: ToolContext,
  input: Parameters<typeof settleRandomWagerCore>[1],
): Promise<string> {
  return settleRandomWagerCore(ctx, input);
}

export async function settleRandomWagerResponse(
  ctx: ToolContext,
  input: Parameters<typeof settleRandomWagerCore>[1],
): Promise<AgentResponse> {
  let settled = false;
  const content = await settleRandomWagerCore(ctx, input, () => { settled = true; });
  return {
    content,
    status: settled ? "ok" : "error",
    retryable: !settled,
    outcome: { kind: "wager", state: settled ? "settled" : "failed", terminal: settled },
  };
}

async function settleRandomWagerCore(
  ctx: ToolContext,
  input: {
    wagerId?: string;
    payoutUsd?: number;
    outcome?: WagerSettlementOutcome;
    resolutionSource?: WagerResolutionSource;
    explanation?: string;
  },
  onSettled?: () => void,
): Promise<string> {
  if (!ctx.config.payments.userWalletsEnabled) return "User wallets and wallet-backed wagers are not enabled in this deployment.";
  if (!ctx.walletService) return "Wallet-backed wagers are not enabled in this deployment.";
  const requestId = ctx.requestId ?? ctx.requestMessageId;
  if (!requestId) return "A stable request id is required before a wager can be settled.";
  const wager = await currentWagerForContext(ctx);
  if (!wager) {
    return "Settlement rejected: no active wallet wager exists for this player in this Discord game session. No transfer was created.";
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
  const wagerId = wager.id;
  let proposal: WagerSettlementProposal | undefined;
  if (!isStandardWagerGame(wager.game)) {
    const explanation = input.explanation?.trim();
    if (input.payoutUsd == null || !Number.isFinite(input.payoutUsd) || input.payoutUsd < 0) {
      return "payoutUsd must be a non-negative amount for a custom game.";
    }
    if (!explanation) return "explanation is required for a custom game and must show how the payout follows from the draw.";
    if (!isSettlementOutcome(input.outcome)) return "outcome must be player_win, player_loss, or push for a custom game.";
    if (!isResolutionSource(input.resolutionSource)) {
      return "resolutionSource must be verified_randomness or player_decision for a custom game.";
    }
    proposal = {
      payoutUsd: input.payoutUsd,
      outcome: input.outcome,
      resolutionSource: input.resolutionSource,
      explanation,
    };
  }
  const settlement = await prepareStandardWagerSettlement(ctx, wager, proposal);
  if (typeof settlement === "string") return settlement;
  let settled: Awaited<ReturnType<typeof ctx.walletService.settleWager>>;
  try {
    settled = await ctx.walletService.settleWager(
      {
        wagerId,
        userId: ctx.userId,
        requestId,
        payoutUsd: settlement.payoutUsd,
        outcome: settlement.outcome,
        resolutionSource: settlement.resolutionSource,
        explanation: settlement.explanation,
      },
      paymentRecorder(ctx)
    );
  } catch (error) {
    if (isPaymentDomainError(error)) {
      return `Settlement rejected: ${error.message}. No transfer was created.`;
    }
    throw error;
  }
  onSettled?.();
  return [
    `The scoped wallet wager settled.`,
    `Payout: $${settlement.payoutUsd}.`,
    settled.transfer
      ? `Net transfer: $${atomicToUsd(settled.transfer.amountAtomic, settled.transfer.tokenDecimals)} USD (${settled.transfer.status})${settled.transfer.transactionHash ? ` · ${settled.transfer.transactionHash}` : ""}.`
      : "Net transfer: none (the payout equals the stake).",
    settled.userBalance ? `User wallet balance: $${settled.userBalance.formatted} USD.` : null,
    `Calculation: ${settlement.explanation}`
  ].filter((line): line is string => line !== null).join("\n");
}

function isSettlementOutcome(value: unknown): value is WagerSettlementOutcome {
  return value === "player_win" || value === "player_loss" || value === "push";
}

function isResolutionSource(value: unknown): value is WagerResolutionSource {
  return value === "verified_randomness" || value === "player_decision";
}

export async function revealRandomness(ctx: ToolContext): Promise<string> {
  return revealRandomnessCore(ctx);
}

export async function revealRandomnessResponse(ctx: ToolContext): Promise<AgentResponse> {
  let revealed = false;
  const content = await revealRandomnessCore(ctx, () => { revealed = true; });
  return {
    content,
    status: revealed ? "ok" : "error",
    retryable: !revealed,
    outcome: { kind: "rng_reveal", state: revealed ? "succeeded" : "failed", terminal: true },
  };
}

async function revealRandomnessCore(ctx: ToolContext, onRevealed?: () => void): Promise<string> {
  const setup = await ensureRngSetup(ctx, "revealRandomness", {});
  if (typeof setup === "string") return setup;
  const { rngRepo, threadKey } = setup;

  const nextServerSeed = generateServerSeed();
  const result = await rngRepo.revealAndRollover({
    threadKey,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    createdByUserId: ctx.userId,
    successorServerSeed: nextServerSeed,
    successorCommitment: rngCommitment(nextServerSeed)
  });

  if (result.status === "no_session") {
    await auditRng(ctx, "revealRandomness", {}, "no active session");
    return 'There is no active provably fair randomness session for this request. Reply "reveal randomness" to a random result, or make a draw to start a session.';
  }
  if (result.status === "no_draws") {
    await auditRng(ctx, "revealRandomness", {}, `session ${result.session.id} has no draws`);
    return [
      `The current session ${result.session.id} has no draws yet, so there is nothing to reveal.`,
      `Its commitment is sha256:${result.session.commitment}; the server seed stays secret until a draw has used it.`
    ].join("\n");
  }

  const { revealed, draws, successor } = result;
  const commitmentOk = verifyRngCommitment(revealed.serverSeed, revealed.commitment);

  const drawLines = draws
    .slice(0, MAX_REVEAL_DRAW_LINES)
    .map((draw) => `- nonce ${draw.nonce} · ${draw.kind}${draw.reason ? ` (${draw.reason})` : ""} → ${summarizeStoredOutcome(draw.outcome)}`);
  if (draws.length > MAX_REVEAL_DRAW_LINES) drawLines.push(`- … and ${draws.length - MAX_REVEAL_DRAW_LINES} more draws (see the verifier output)`);

  ensureAgentTurnOutput(ctx).addFooterLines(
    `🎲 revealed session ${revealed.id} · server seed ${revealed.serverSeed} · client seed ${revealed.clientSeed ?? "unset"}`,
    `🎲 next fair-play commit sha256:${successor.commitment}`
  );

  await auditRng(ctx, "revealRandomness", {}, `revealed session ${revealed.id} with ${draws.length} draws; next session ${successor.id}`).catch(() => undefined);
  onRevealed?.();

  return [
    `Revealed session ${revealed.id}.`,
    `Server seed: ${revealed.serverSeed}`,
    `Commitment: sha256:${revealed.commitment} (${commitmentOk ? "verified: SHA-256 of the server seed matches" : "WARNING: commitment does not match the server seed"})`,
    `Client seed: ${revealed.clientSeed ?? "unset"} (${describeClientSeedSource(revealed.clientSeedSource)})`,
    `Draws (${draws.length}):`,
    ...drawLines,
    ``,
    `Anyone can verify with: npm run verify:rng -- --session ${revealed.id}`,
    `Or without database access: recompute sha256(serverSeed) and each draw from HMAC-SHA256(serverSeed, "clientSeed:nonce:block"); see docs/payments.md.`,
    `A fresh commitment (${shortHash(successor.commitment)}…) now covers future draws in this thread; the proof footer on this reply carries the full values.`,
    `Report the seed and commitment values exactly as shown; the proof footer repeats them verbatim.`
  ].join("\n");
}

type DrawResult = {
  drawId: number;
  nonce: number;
  summary: string;
  footerLine: string;
  shuffleFooter?: string;
};

type DrawTxResult =
  | { ok: false; error: string }
  | {
      ok: true;
      draw: DrawResult;
      sessionId: string;
      commitment: string;
      clientSeed: string;
      showCommit: boolean;
    };

async function drawBasic(
  tx: RngSessionTx,
  ctx: ToolContext,
  clientSeed: string,
  kind: RngDrawKind,
  input: DrawRandomInput,
  reason: string | null
): Promise<DrawResult> {
  const params = drawParamsFor(kind, input);
  const nonce = await tx.takeNonce();
  const outcome = computeRngOutcome({ serverSeed: tx.session.serverSeed, clientSeed, nonce, kind, params });
  const stored = await tx.recordDraw({
    nonce,
    kind,
    params: params as Record<string, unknown>,
    outcome: outcome as unknown as Record<string, unknown>,
    reason,
    requestId: ctx.requestId ?? null,
    messageId: ctx.requestMessageId ?? null,
    requestedByUserId: ctx.userId
  });

  let summary = formatRngOutcome(outcome);
  if (kind === "shuffle" && outcome.kind === "shuffle") {
    const options = params.options ?? [];
    summary = outcome.permutation.map((index) => options[index]).join(", ");
  }
  const label = describeDraw(kind, params, reason);
  return {
    drawId: stored.id,
    nonce,
    summary: `${label} → ${summary}`,
    footerLine: `🎲 ${label} → ${truncate(summary, MAX_FOOTER_OUTCOME_CHARS)} · nonce ${nonce} · session ${tx.session.id}`
  };
}

async function drawCards(
  tx: RngSessionTx,
  ctx: ToolContext,
  clientSeed: string,
  input: DrawRandomInput,
  reason: string | null
): Promise<DrawResult> {
  const count = input.count ?? 1;
  const requestedDeckCount = input.deckCount;
  const deckCount = requestedDeckCount ?? tx.session.deckCount ?? 1;
  const size = deckCount * CARDS_PER_DECK;

  let shuffleFooter: string | undefined;
  const remaining =
    tx.session.deckPosition == null || tx.session.deckCount == null
      ? 0
      : tx.session.deckCount * CARDS_PER_DECK - tx.session.deckPosition;
  const needNewShoe =
    tx.session.shuffleNonce == null ||
    tx.session.deckPosition == null ||
    tx.session.deckCount == null ||
    (requestedDeckCount != null && requestedDeckCount !== tx.session.deckCount) ||
    count > remaining;

  if (needNewShoe) {
    const nonce = await tx.takeNonce();
    const outcome = computeRngOutcome({
      serverSeed: tx.session.serverSeed,
      clientSeed,
      nonce,
      kind: "shuffle",
      params: { size }
    });
    await tx.recordDraw({
      nonce,
      kind: "shuffle",
      params: { size, deckCount, shoe: true },
      outcome: outcome as unknown as Record<string, unknown>,
      reason: "new shoe",
      requestId: ctx.requestId ?? null,
      messageId: ctx.requestMessageId ?? null,
      requestedByUserId: ctx.userId
    });
    await tx.setShoe({ deckCount, shuffleNonce: nonce });
    shuffleFooter = `🎲 shuffled a new ${size}-card shoe (${deckCount} deck${deckCount > 1 ? "s" : ""}) · nonce ${nonce} · session ${tx.session.id}`;
  }

  const shuffleNonce = tx.session.shuffleNonce;
  if (shuffleNonce == null) throw new Error(`RNG session ${tx.session.id} has no shoe after shuffle`);
  const start = await tx.claimDeckCards(count);
  // Unreachable: the shoe was validated/reshuffled above while the session row is locked.
  if (start == null) throw new Error(`RNG session ${tx.session.id} shoe accounting failed`);

  const cards = deckCardsAt({
    serverSeed: tx.session.serverSeed,
    clientSeed,
    shuffleNonce,
    deckCount,
    start,
    count
  });
  const stored = await tx.recordDraw({
    nonce: shuffleNonce,
    kind: "cards",
    params: { deckCount, start, count },
    outcome: { kind: "cards", cards, deckCount, start, count },
    reason,
    requestId: ctx.requestId ?? null,
    messageId: ctx.requestMessageId ?? null,
    requestedByUserId: ctx.userId
  });

  const label = reason ? `cards (${reason})` : "cards";
  const summary = cards.join(" ");
  return {
    drawId: stored.id,
    nonce: shuffleNonce,
    summary: `${label} → ${summary} · shoe cards ${start + 1}–${start + count} of ${size}`,
    footerLine: `🎲 ${label} → ${truncate(summary, MAX_FOOTER_OUTCOME_CHARS)} · nonce ${shuffleNonce} · shoe ${start + 1}–${start + count}/${size} · session ${tx.session.id}`,
    shuffleFooter
  };
}

async function ensureRngSetup(
  ctx: ToolContext,
  toolName: "drawRandom" | "revealRandomness",
  input: Record<string, unknown>
): Promise<{ rngRepo: RngRepository; threadKey: string } | string> {
  if (!ctx.rngRepo) {
    await auditRng(ctx, toolName, input, "rng repository unavailable");
    return "Provably fair RNG is unavailable in this runtime (no RNG store is wired up), so I cannot produce verifiable random results here.";
  }
  const baseThreadKey = ctx.threadKey?.trim();
  if (!baseThreadKey) {
    await auditRng(ctx, toolName, input, "missing thread key");
    return "Provably fair RNG is unavailable for this request because it has no conversation thread key.";
  }
  const replyRootMessageId = ctx.replyContext?.rootMessageId?.trim();
  const requestMessageId = ctx.requestMessageId?.trim();
  const rootMessageId = replyRootMessageId || requestMessageId;
  if (!rootMessageId) return { rngRepo: ctx.rngRepo, threadKey: baseThreadKey };

  const threadKeyPrefix = `${baseThreadKey}:${RNG_ROOT_SCOPE_SEGMENT}:`;
  return { rngRepo: ctx.rngRepo, threadKey: `${threadKeyPrefix}${rootMessageId}` };
}

export function wagerThreadKeyForContext(ctx: ToolContext): string | null {
  const baseThreadKey = ctx.threadKey?.trim();
  if (!baseThreadKey) return null;
  const rootMessageId = ctx.replyContext?.rootMessageId?.trim() || ctx.requestMessageId?.trim();
  return rootMessageId ? `${baseThreadKey}:${RNG_ROOT_SCOPE_SEGMENT}:${rootMessageId}` : baseThreadKey;
}

export async function currentWagerForContext(ctx: ToolContext): Promise<WagerReservation | null> {
  if (!ctx.walletService || typeof ctx.walletService.getCurrentWager !== "function") return null;
  const threadKey = wagerThreadKeyForContext(ctx);
  if (!threadKey) return null;
  return ctx.walletService.getCurrentWager({ threadKey, userId: ctx.userId });
}

function drawParamsFor(kind: RngDrawKind, input: DrawRandomInput): RngDrawParams {
  switch (kind) {
    case "integers":
      return { count: input.count ?? 1, min: input.min, max: input.max };
    case "dice":
      return { count: input.count ?? 1, sides: input.sides ?? 6 };
    case "coin":
      return { count: input.count ?? 1 };
    case "pick":
      return { count: input.count ?? 1, options: normalizeOptions(input.options) };
    case "shuffle": {
      const options = normalizeOptions(input.options);
      return { size: options.length, options };
    }
  }
}

function describeDraw(kind: RngDrawKind, params: RngDrawParams, reason: string | null): string {
  const suffix = reason ? ` (${reason})` : "";
  switch (kind) {
    case "integers":
      return `integers ${params.min}–${params.max}${(params.count ?? 1) > 1 ? ` ×${params.count}` : ""}${suffix}`;
    case "dice":
      return `dice ${params.count ?? 1}d${params.sides ?? 6}${suffix}`;
    case "coin":
      return `coin${(params.count ?? 1) > 1 ? ` ×${params.count}` : ""}${suffix}`;
    case "pick":
      return `pick${(params.count ?? 1) > 1 ? ` ${params.count}` : ""} of ${params.options?.length ?? 0}${suffix}`;
    case "shuffle":
      return `shuffle ${params.size ?? params.options?.length ?? 0} items${suffix}`;
  }
}

function summarizeStoredOutcome(outcome: Record<string, unknown>): string {
  if (Array.isArray(outcome.cards)) return truncate((outcome.cards as string[]).join(" "), 120);
  if (Array.isArray(outcome.values)) return truncate((outcome.values as unknown[]).join(", "), 120);
  if (Array.isArray(outcome.permutation)) return `permutation of ${(outcome.permutation as unknown[]).length}`;
  return truncate(JSON.stringify(outcome), 120);
}

function describeClientSeedSource(source: string | null): string {
  if (source === "discord_message_id") return "the Discord id of the message that triggered the first draw — assigned by Discord, not by the bot";
  if (source === "request_id") return "the internal request id of the first draw";
  return "generated locally";
}

function normalizeOptions(options: string[] | undefined): string[] {
  return (options ?? [])
    .map((option) => (typeof option === "string" ? option.trim() : ""))
    .filter((option) => option.length > 0);
}

function normalizeReason(reason: string | undefined): string | null {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function shortHash(value: string): string {
  return value.slice(0, 16);
}

async function auditRng(
  ctx: ToolContext,
  toolName: "drawRandom" | "revealRandomness",
  input: Record<string, unknown>,
  resultSummary: string
): Promise<void> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName,
    argumentsSummary: summarizeForAudit(input),
    resultSummary: summarizeForAudit(resultSummary)
  });
}
