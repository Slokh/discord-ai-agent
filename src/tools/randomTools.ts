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
import type { ToolContext } from "./types.js";

export type DrawRandomInput = {
  kind?: string;
  count?: number;
  min?: number;
  max?: number;
  sides?: number;
  options?: string[];
  deckCount?: number;
  reason?: string;
  wager?: {
    stakeUsd?: number;
    maxPayoutUsd?: number;
    game?: string;
  };
};

const MAX_COUNT = 100;
const MAX_OPTIONS = 100;
const MAX_SIDES = 1_000_000;
const MAX_FOOTER_OUTCOME_CHARS = 160;
const MAX_REVEAL_DRAW_LINES = 25;
const RNG_ROOT_SCOPE_SEGMENT = "rng-root";

const DRAW_KINDS = new Set(["integers", "dice", "coin", "pick", "shuffle", "cards"]);

export async function drawRandom(ctx: ToolContext, input: DrawRandomInput): Promise<string> {
  const kind = (input.kind ?? "").trim();
  if (!DRAW_KINDS.has(kind)) {
    await auditRng(ctx, "drawRandom", input, `unknown kind "${kind}"`);
    return `Unknown draw kind "${kind}". Supported kinds: integers, dice, coin, pick, shuffle, cards.`;
  }
  if (ctx.config.payments.userWalletsEnabled && !input.wager && requiresWalletBackedWagerForContext(ctx)) {
    const error = "This request risks real USD, so drawRandom requires a wallet-backed wager with stakeUsd, maxPayoutUsd, and game before any randomness is consumed.";
    await auditRng(ctx, "drawRandom", input, error);
    return error;
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
  if (input.wager && hasUncommittedPlayerSecretWager(ctx.requestText ?? "")) {
    const error = "This real-money wager is not verifiable because its outcome depends on a secret the player can reveal or change after the bot acts. No funds were reserved and no random draw was made. Use play money or a result that was independently committed before the wager.";
    await auditRng(ctx, "drawRandom", input, error);
    return error;
  }
  const explicitStakeUsd = explicitBareWagerAmount(ctx.requestText);
  if (input.wager && explicitStakeUsd != null && Math.abs(input.wager.stakeUsd! - explicitStakeUsd) > 1e-9) {
    const error = `Wager stake must match the explicit amount in the current request: $${explicitStakeUsd}. Retry drawRandom with stakeUsd=${explicitStakeUsd}; do not reuse an amount from conversation history.`;
    await auditRng(ctx, "drawRandom", input, error);
    return error;
  }
  let wager: WagerReservation | null = null;
  if (input.wager) {
    if (!ctx.config.payments.userWalletsEnabled) return "User wallets and wallet-backed wagers are not enabled in this deployment.";
    if (!ctx.walletService) return "Wallet-backed wagers are not enabled in this deployment.";
    const requestId = ctx.requestId ?? ctx.requestMessageId;
    if (!requestId) return "A stable request id is required before a wallet-backed wager can be reserved.";
    try {
      wager = await ctx.walletService.reserveWager(
        {
          requestId,
          guildId: ctx.guildId,
          channelId: ctx.channelId,
          threadKey,
          userId: ctx.userId,
          game: input.wager.game!.trim(),
          interactionMode: inferWagerInteractionMode(ctx.requestText ?? "", input.wager.game!),
          stakeUsd: input.wager.stakeUsd!,
          maxPayoutUsd: input.wager.maxPayoutUsd!
        },
        paymentRecorder(ctx)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists for this Discord request/i.test(message)) {
        const result = "A wallet-backed wager has already been reserved for this Discord request. Use the first successful draw and settle that wager; do not draw or reserve another wager.";
        await auditRng(ctx, "drawRandom", input, result);
        return result;
      }
      if (/active wallet-backed game already exists/i.test(message)) {
        const result = "An active wallet-backed game already exists in this Discord reply chain. Continue that game from its saved state or settle it before starting another wager.";
        await auditRng(ctx, "drawRandom", input, result);
        return result;
      }
      if (/Insufficient user wallet balance/i.test(message)) {
        const result = "The wager could not be reserved because the user's available wallet balance is below the requested stake. Available balance excludes active wager and transfer reservations; gas fees are paid by the bot fee payer and are not deducted from the user.";
        await auditRng(ctx, "drawRandom", input, result);
        return result;
      }
      throw error;
    }
  }

  const clientSeedValue = ctx.requestMessageId ?? ctx.requestId ?? generateServerSeed();
  const clientSeedSource = ctx.requestMessageId ? "discord_message_id" : ctx.requestId ? "request_id" : "random";
  const reason = normalizeReason(input.reason);
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
  ctx.footerLines?.push(...footerLines);

  await auditRng(ctx, "drawRandom", input, `session ${sessionId} nonce ${draw.nonce}: ${draw.summary}`);

  return [
    `Provably fair draw complete.`,
    `Result: ${draw.summary}`,
    `Session ${sessionId} · nonce ${draw.nonce} · draw ${draw.drawId} · commitment sha256:${commitment}`,
    wager
      ? `The scoped wallet wager is reserved. You MUST now either call awaitRandomWagerAction with complete state if the player has a decision, or call settleRandomWager once after a final outcome. The runtime resolves the wager from this Discord game session; do not supply or repeat an internal wager id.`
      : null,
    `Report this result exactly as shown. A proof footer is appended to your reply automatically; do not restate or alter the proof details.`
  ].filter((line): line is string => line !== null).join("\n");
}

export function requiresWalletBackedWager(text: string): boolean {
  const amount = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
  const money = new RegExp(String.raw`(?:\$\s*${amount}|(?<![\w.])${amount}\s*(?:usd|dollars?|bucks?)\b)`, "i");
  const shorthand = new RegExp(String.raw`(?:\b(?:bet|wager|stake|risk|put)\s+\$?${amount}(?![\w.])|(?<![\w.])\$?${amount}\s+(?:on|per\s+(?:spin|hand|roll|game)|each)\b)`, "i");
  const game = /\b(?:casino|slots?|spins?|blackjack|roulette|poker|craps|dice|coin\s*flip|flip\s+a\s+coin|heads|tails|lottery|wager|bet)\b/i;
  const action = /\b(?:play|run|do|give|deal|roll|flip|spin|bet|wager|stake|risk|put|again|more)\b/i;
  return game.test(text) && ((money.test(text) && action.test(text)) || shorthand.test(text));
}

export function requiresWalletBackedWagerForContext(ctx: ToolContext): boolean {
  const requestText = ctx.requestText ?? "";
  if (requiresWalletBackedWager(requestText)) return true;
  if (!/^\s*(?:again|same(?:\s+thing)?|one\s+more|do\s+it\s+again|repeat)\b/i.test(requestText)) return false;
  const previousRequesterPrompt = [...(ctx.sessionMessages ?? [])]
    .reverse()
    .find((message) => message.role === "user" && message.authorId === ctx.userId && message.content.trim());
  return previousRequesterPrompt ? requiresWalletBackedWager(previousRequesterPrompt.content) : false;
}

export async function settleRandomWager(
  ctx: ToolContext,
  input: {
    wagerId?: string;
    payoutUsd?: number;
    outcome?: WagerSettlementOutcome;
    resolutionSource?: WagerResolutionSource;
    explanation?: string;
  }
): Promise<string> {
  if (!ctx.config.payments.userWalletsEnabled) return "User wallets and wallet-backed wagers are not enabled in this deployment.";
  if (!ctx.walletService) return "Wallet-backed wagers are not enabled in this deployment.";
  const explanation = input.explanation?.trim();
  const requestId = ctx.requestId ?? ctx.requestMessageId;
  if (!requestId) return "A stable request id is required before a wager can be settled.";
  if (input.payoutUsd == null || !Number.isFinite(input.payoutUsd) || input.payoutUsd < 0) {
    return "payoutUsd must be a non-negative amount.";
  }
  if (!explanation) return "explanation is required and must show how the payout follows from the draw.";
  if (!isSettlementOutcome(input.outcome)) return "outcome must be player_win, player_loss, or push.";
  if (!isResolutionSource(input.resolutionSource)) {
    return "resolutionSource must be verified_randomness or player_decision.";
  }
  if (describesUnfinishedWager(explanation)) {
    return "Settlement rejected: the calculation describes an unfinished game. If the player has a decision, call awaitRandomWagerAction with complete versioned state and allowed actions. Otherwise resolve the remaining deterministic steps and call settleRandomWager again with the final payout.";
  }
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
  let settled: Awaited<ReturnType<typeof ctx.walletService.settleWager>>;
  try {
    settled = await ctx.walletService.settleWager(
      {
        wagerId,
        userId: ctx.userId,
        requestId,
        payoutUsd: input.payoutUsd,
        outcome: input.outcome,
        resolutionSource: input.resolutionSource,
        explanation
      },
      paymentRecorder(ctx)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown wager|not ready to settle|has expired|payout is outside|only the user|settlement outcome|interactive wager|persisted player decision|new Discord reply|stable settlement request/i.test(message)) {
      return `Settlement rejected: ${message}. No transfer was created.`;
    }
    throw error;
  }
  return [
    `The scoped wallet wager settled.`,
    `Payout: $${input.payoutUsd}.`,
    settled.transfer
      ? `Net transfer: $${atomicToUsd(settled.transfer.amountAtomic, settled.transfer.tokenDecimals)} USD (${settled.transfer.status})${settled.transfer.transactionHash ? ` · ${settled.transfer.transactionHash}` : ""}.`
      : "Net transfer: none (the payout equals the stake).",
    settled.userBalance ? `User wallet balance: $${settled.userBalance.formatted} USD.` : null,
    `Calculation: ${explanation}`
  ].filter((line): line is string => line !== null).join("\n");
}

export function hasUncommittedPlayerSecretWager(text: string): boolean {
  const secret = String.raw`(?:number|digit|word|name|card|color|colour|symbol|thing|answer)`;
  const playerPossession = new RegExp(
    String.raw`\b(?:i(?:'m|\s+am)\s+thinking\s+of|i(?:'ve|\s+have)\s+(?:picked|chosen|selected)|i\s+(?:picked|chose|selected)|(?:in|on)\s+my\s+(?:head|mind))\b`,
    "i"
  );
  const guessSecret = new RegExp(
    String.raw`\bguess(?:es|ed|ing)?\b[^.!?\n]{0,80}\b${secret}\b[^.!?\n]{0,80}(?:thinking\s+of|picked|chosen|selected|in\s+(?:my|your)\s+(?:head|mind))`,
    "i"
  );
  const directSecret = new RegExp(
    String.raw`\b${secret}\b[^.!?\n]{0,30}(?:i(?:'m|\s+am)\s+thinking\s+of|i(?:'ve|\s+have)\s+(?:picked|chosen|selected)|i\s+(?:picked|chose|selected)|in\s+my\s+(?:head|mind))`,
    "i"
  );
  return /\b(?:guess|predict|tell)\b/i.test(text) && playerPossession.test(text) && (guessSecret.test(text) || directSecret.test(text));
}

export function inferWagerInteractionMode(text: string, game: string): WagerInteractionMode {
  const combined = `${game}\n${text}`;
  if (/\b(?:blackjack|poker|hold\s*['’]?em|yahtzee|video\s+poker)\b/i.test(combined)) {
    return "player_decisions";
  }
  if (/\b(?:choose\s+(?:after|whether)|ask\s+me|let\s+me\s+(?:choose|decide))\b/i.test(combined)) {
    return "player_decisions";
  }
  if (/\b(?:slots?|roulette|craps|dice|die\s+roll|coin\s*flip|heads|tails|wheel|lottery|raffle|random\s+(?:pick|draw|number)|(?:digit|number)[\s_-]*(?:bet|draw)|(?:generate|draw|pick)\s+(?:a\s+)?(?:\d+\s*[- ]?digit\s+)?number)\b/i.test(combined)) {
    return "automatic";
  }
  if (/\b(?:hit|stand|double\s+down|split|fold|call|raise|hold|discard)\b/i.test(combined)) {
    return "player_decisions";
  }
  return "player_decisions";
}

function isSettlementOutcome(value: unknown): value is WagerSettlementOutcome {
  return value === "player_win" || value === "player_loss" || value === "push";
}

function isResolutionSource(value: unknown): value is WagerResolutionSource {
  return value === "verified_randomness" || value === "player_decision";
}

function describesUnfinishedWager(explanation: string): boolean {
  return /\b(?:in\s+progress|await(?:ing|s)?|pending|hit\s+or\s+stand|not\s+(?:yet\s+)?(?:finished|complete|resolved|decided|settled)|to\s+be\s+(?:continued|completed|decided))\b/i.test(explanation);
}

function explicitBareWagerAmount(requestText: string | undefined): number | null {
  const match = requestText?.trim().match(/^\$?\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:usd|dollars?|bucks?)?\s*[.!?]?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function revealRandomness(ctx: ToolContext): Promise<string> {
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

  ctx.footerLines?.push(
    `🎲 revealed session ${revealed.id} · server seed ${revealed.serverSeed} · client seed ${revealed.clientSeed ?? "unset"}`,
    `🎲 next fair-play commit sha256:${successor.commitment}`
  );

  await auditRng(ctx, "revealRandomness", {}, `revealed session ${revealed.id} with ${draws.length} draws; next session ${successor.id}`);

  return [
    `Revealed session ${revealed.id}.`,
    `Server seed: ${revealed.serverSeed}`,
    `Commitment: sha256:${revealed.commitment} (${commitmentOk ? "verified: SHA-256 of the server seed matches" : "WARNING: commitment does not match the server seed"})`,
    `Client seed: ${revealed.clientSeed ?? "unset"} (${describeClientSeedSource(revealed.clientSeedSource)})`,
    `Draws (${draws.length}):`,
    ...drawLines,
    ``,
    `Anyone can verify with: npm run verify:rng -- --session ${revealed.id}`,
    `Or without database access: recompute sha256(serverSeed) and each draw from HMAC-SHA256(serverSeed, "clientSeed:nonce:block"); see docs/provable-rng.md.`,
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
  if (toolName === "revealRandomness" && !replyRootMessageId) {
    const latestThreadKey = await ctx.rngRepo.findLatestDrawnActiveSessionThreadKey({
      channelId: ctx.channelId,
      requestedByUserId: ctx.userId,
      legacyThreadKey: baseThreadKey,
      threadKeyPrefix
    });
    if (latestThreadKey) return { rngRepo: ctx.rngRepo, threadKey: latestThreadKey };
  }
  return { rngRepo: ctx.rngRepo, threadKey: `${threadKeyPrefix}${rootMessageId}` };
}

export function wagerThreadKeyForContext(ctx: ToolContext): string | null {
  const baseThreadKey = ctx.threadKey?.trim();
  if (!baseThreadKey) return null;
  const rootMessageId = ctx.replyContext?.rootMessageId?.trim() || ctx.requestMessageId?.trim();
  return rootMessageId ? `${baseThreadKey}:${RNG_ROOT_SCOPE_SEGMENT}:${rootMessageId}` : baseThreadKey;
}

export async function currentWagerForContext(ctx: ToolContext): Promise<WagerReservation | null> {
  if (!ctx.walletService) return null;
  const threadKey = wagerThreadKeyForContext(ctx);
  if (!threadKey) return null;
  return ctx.walletService.getCurrentWager({ threadKey, userId: ctx.userId });
}

function validateDrawInput(kind: string, input: DrawRandomInput): string | null {
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) {
    return `count must be an integer between 1 and ${MAX_COUNT}.`;
  }
  switch (kind) {
    case "integers": {
      const missing = [input.min == null ? "min" : null, input.max == null ? "max" : null].filter(
        (name): name is string => name !== null
      );
      if (missing.length > 0) {
        const sidesHint =
          input.max == null && typeof input.sides === "number" && Number.isSafeInteger(input.sides)
            ? ` You passed sides=${input.sides}, which belongs to kind "dice", not "integers". For a range of ${input.sides} values starting at ${input.min ?? 0}, use min ${input.min ?? 0} and max ${(input.min ?? 0) + input.sides - 1}; for dice, use {"kind": "dice", "sides": ${input.sides}}.`
            : "";
        return `integers draws require both min and max (inclusive bounds). Missing: ${missing.join(" and ")}. Example: {"kind": "integers", "min": 0, "max": 36} for a roulette wheel.${sidesHint} Do not ask the user to fix this; retry drawRandom now with corrected arguments.`;
      }
      if (!Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max)) {
        return `min and max must be whole numbers, but got min=${JSON.stringify(input.min)} and max=${JSON.stringify(input.max)}. Do not ask the user to fix this; retry drawRandom now with integer min and max.`;
      }
      const min = input.min as number;
      const max = input.max as number;
      if (min > max) return "min must be less than or equal to max.";
      if (max - min + 1 > 0x1_0000_0000) return "The min..max range is too large (max 2^32 values).";
      return null;
    }
    case "dice": {
      const sides = input.sides ?? 6;
      if (!Number.isSafeInteger(sides) || sides < 2 || sides > MAX_SIDES) {
        return `sides must be an integer between 2 and ${MAX_SIDES}.`;
      }
      return null;
    }
    case "coin":
      return null;
    case "pick":
    case "shuffle": {
      const options = normalizeOptions(input.options);
      if (options.length < 2) return `${kind} draws need at least 2 non-empty options.`;
      if (options.length > MAX_OPTIONS) return `${kind} draws support at most ${MAX_OPTIONS} options.`;
      if (kind === "pick" && count > options.length) return "pick count cannot exceed the number of options.";
      return null;
    }
    case "cards": {
      const deckCount = input.deckCount;
      if (deckCount != null && (!Number.isSafeInteger(deckCount) || deckCount < 1 || deckCount > MAX_DECK_COUNT)) {
        return `deckCount must be an integer between 1 and ${MAX_DECK_COUNT}.`;
      }
      return null;
    }
    default:
      return `Unknown draw kind "${kind}".`;
  }
}

function validateWagerInput(input: DrawRandomInput): string | null {
  if (!input.wager) return null;
  const { stakeUsd, maxPayoutUsd, game } = input.wager;
  if (!Number.isFinite(stakeUsd) || (stakeUsd ?? 0) <= 0) return "wager.stakeUsd must be a positive amount.";
  if (!Number.isFinite(maxPayoutUsd) || (maxPayoutUsd ?? -1) < 0) {
    return "wager.maxPayoutUsd must be a non-negative amount that includes any returned stake.";
  }
  if (!game?.trim()) return "wager.game is required.";
  if (input.kind === "cards" && (input.count ?? 1) < 4) {
    return "A wallet-backed card game must draw its complete bounded game sequence in one call with count at least 4; do not draw one wagered card per model round.";
  }
  return null;
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
