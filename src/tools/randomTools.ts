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
};

const MAX_COUNT = 100;
const MAX_OPTIONS = 100;
const MAX_SIDES = 1_000_000;
const MAX_FOOTER_OUTCOME_CHARS = 160;
const MAX_REVEAL_DRAW_LINES = 25;

const DRAW_KINDS = new Set(["integers", "dice", "coin", "pick", "shuffle", "cards"]);

export async function drawRandom(ctx: ToolContext, input: DrawRandomInput): Promise<string> {
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

  const clientSeedValue = ctx.requestMessageId ?? ctx.requestId ?? generateServerSeed();
  const clientSeedSource = ctx.requestMessageId ? "discord_message_id" : ctx.requestId ? "request_id" : "random";
  const reason = normalizeReason(input.reason);
  // Candidate seed for a new session; discarded unpublished when one already exists.
  const candidateServerSeed = generateServerSeed();

  const result = await rngRepo.withActiveSession<DrawTxResult>(
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

  if (!result.ok) {
    await auditRng(ctx, "drawRandom", input, result.error);
    return result.error;
  }
  const { draw, sessionId, commitment, clientSeed, showCommit } = result;

  const footerLines: string[] = [];
  if (draw.shuffleFooter) footerLines.push(draw.shuffleFooter);
  footerLines.push(draw.footerLine);
  if (showCommit) {
    footerLines.push(
      `🎲 fair-play commit sha256:${commitment} · client seed ${clientSeed} · say "reveal randomness" to verify`
    );
  }
  ctx.footerLines?.push(...footerLines);

  await auditRng(ctx, "drawRandom", input, `session ${sessionId} nonce ${draw.nonce}: ${draw.summary}`);

  return [
    `Provably fair draw complete.`,
    `Result: ${draw.summary}`,
    `Session ${sessionId} · nonce ${draw.nonce} · commitment sha256:${commitment}`,
    `Report this result exactly as shown. A proof footer is appended to your reply automatically; do not restate or alter the proof details.`
  ].join("\n");
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
    return "There is no active provably fair randomness session in this thread. Draws create one automatically.";
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
  await tx.recordDraw({
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
  await tx.recordDraw({
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
  const threadKey = ctx.threadKey?.trim();
  if (!threadKey) {
    await auditRng(ctx, toolName, input, "missing thread key");
    return "Provably fair RNG is unavailable for this request because it has no conversation thread key.";
  }
  return { rngRepo: ctx.rngRepo, threadKey };
}

function validateDrawInput(kind: string, input: DrawRandomInput): string | null {
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) {
    return `count must be an integer between 1 and ${MAX_COUNT}.`;
  }
  switch (kind) {
    case "integers": {
      if (!Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max)) {
        return "integers draws need integer min and max values.";
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
