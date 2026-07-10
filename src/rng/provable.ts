import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Provably fair RNG primitives (commit-reveal scheme).
 *
 * A session commits to SHA-256(serverSeed) before any outcome is produced.
 * Every entropy-consuming operation derives its bytes from
 * HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${block}`), so after the
 * server seed is revealed anyone can recompute every outcome and check it
 * against the commitment. This module is pure: both the live tool and the
 * offline verifier (`scripts/verify-rng.ts`) call the same functions, so a
 * verified recomputation is exactly the computation that produced the result.
 */

export const CARDS_PER_DECK = 52;
export const MAX_DECK_COUNT = 8;

const SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"] as const; // ♠ ♥ ♦ ♣
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

export type RngDrawKind = "integers" | "dice" | "coin" | "pick" | "shuffle";

export type RngDrawParams = {
  count?: number;
  min?: number;
  max?: number;
  sides?: number;
  options?: string[];
  size?: number;
};

export type RngOutcome =
  | { kind: "integers"; values: number[] }
  | { kind: "dice"; values: number[]; total: number }
  | { kind: "coin"; values: ("heads" | "tails")[] }
  | { kind: "pick"; values: string[] }
  | { kind: "shuffle"; permutation: number[] };

export function generateServerSeed(): string {
  return randomBytes(32).toString("hex");
}

export function rngCommitment(serverSeed: string): string {
  return createHash("sha256").update(serverSeed, "utf8").digest("hex");
}

export function verifyRngCommitment(serverSeed: string, commitment: string): boolean {
  const computed = Buffer.from(rngCommitment(serverSeed), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(commitment.trim().toLowerCase(), "hex");
  } catch {
    return false;
  }
  return computed.length === provided.length && timingSafeEqual(computed, provided);
}

/**
 * Deterministic byte stream for one (serverSeed, clientSeed, nonce) draw.
 * Block `i` is HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${i}`).
 */
export function createRngStream(input: { serverSeed: string; clientSeed: string; nonce: number }) {
  let block = 0;
  let buffer = Buffer.alloc(0);
  let offset = 0;

  const refill = () => {
    buffer = createHmac("sha256", input.serverSeed)
      .update(`${input.clientSeed}:${input.nonce}:${block}`, "utf8")
      .digest();
    block += 1;
    offset = 0;
  };

  return {
    nextUint32(): number {
      if (offset + 4 > buffer.length) refill();
      const value = buffer.readUInt32BE(offset);
      offset += 4;
      return value;
    }
  };
}

export type RngStream = ReturnType<typeof createRngStream>;

/** Unbiased integer in [min, max] via rejection sampling. */
export function uniformInt(stream: RngStream, min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new Error(`invalid uniformInt range [${min}, ${max}]`);
  }
  const range = max - min + 1;
  if (range > 0x1_0000_0000) throw new Error("uniformInt range exceeds 2^32");
  if (range === 1) return min;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  for (;;) {
    const value = stream.nextUint32();
    if (value < limit) return min + (value % range);
  }
}

/** Fisher-Yates permutation of [0, size) driven by the stream. */
export function uniformPermutation(stream: RngStream, size: number): number[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error(`invalid permutation size ${size}`);
  const items = Array.from({ length: size }, (_, index) => index);
  for (let i = size - 1; i > 0; i -= 1) {
    const j = uniformInt(stream, 0, i);
    const swap = items[i];
    items[i] = items[j];
    items[j] = swap;
  }
  return items;
}

/**
 * Compute the outcome for one entropy-consuming draw. This is the single
 * source of truth used by both the live RNG tool and the offline verifier.
 */
export function computeRngOutcome(input: {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  kind: RngDrawKind;
  params: RngDrawParams;
}): RngOutcome {
  const stream = createRngStream(input);
  const params = input.params;
  switch (input.kind) {
    case "integers": {
      const count = requirePositiveInt(params.count ?? 1, "count");
      const min = requireSafeInt(params.min, "min");
      const max = requireSafeInt(params.max, "max");
      return { kind: "integers", values: Array.from({ length: count }, () => uniformInt(stream, min, max)) };
    }
    case "dice": {
      const count = requirePositiveInt(params.count ?? 1, "count");
      const sides = requirePositiveInt(params.sides ?? 6, "sides");
      const values = Array.from({ length: count }, () => uniformInt(stream, 1, sides));
      return { kind: "dice", values, total: values.reduce((sum, value) => sum + value, 0) };
    }
    case "coin": {
      const count = requirePositiveInt(params.count ?? 1, "count");
      return {
        kind: "coin",
        values: Array.from({ length: count }, () => (uniformInt(stream, 0, 1) === 0 ? "heads" : "tails"))
      };
    }
    case "pick": {
      const options = params.options ?? [];
      if (options.length < 1) throw new Error("pick requires options");
      const count = requirePositiveInt(params.count ?? 1, "count");
      if (count > options.length) throw new Error("pick count exceeds options");
      const permutation = uniformPermutation(stream, options.length);
      return { kind: "pick", values: permutation.slice(0, count).map((index) => options[index]) };
    }
    case "shuffle": {
      const size = requirePositiveInt(params.size ?? CARDS_PER_DECK, "size");
      return { kind: "shuffle", permutation: uniformPermutation(stream, size) };
    }
  }
}

/** Ordered reference deck: deck 0 ♠A..K, ♥, ♦, ♣, then deck 1, ... */
export function referenceDeckCard(index: number): string {
  const withinDeck = index % CARDS_PER_DECK;
  const suit = SUITS[Math.floor(withinDeck / RANKS.length)];
  const rank = RANKS[withinDeck % RANKS.length];
  return `${rank}${suit}`;
}

/** Cards at [start, start+count) of the shuffled multi-deck shoe. */
export function deckCardsAt(input: {
  serverSeed: string;
  clientSeed: string;
  shuffleNonce: number;
  deckCount: number;
  start: number;
  count: number;
}): string[] {
  const size = input.deckCount * CARDS_PER_DECK;
  if (input.start < 0 || input.count < 1 || input.start + input.count > size) {
    throw new Error(`invalid deck slice [${input.start}, ${input.start + input.count}) of ${size}`);
  }
  const outcome = computeRngOutcome({
    serverSeed: input.serverSeed,
    clientSeed: input.clientSeed,
    nonce: input.shuffleNonce,
    kind: "shuffle",
    params: { size }
  });
  if (outcome.kind !== "shuffle") throw new Error("expected shuffle outcome");
  return outcome.permutation.slice(input.start, input.start + input.count).map(referenceDeckCard);
}

export type StoredRngDrawKind = RngDrawKind | "cards";

/**
 * Recompute the stored outcome for a persisted draw row. This is the shared
 * verification path: the live tool stores exactly what this returns, so the
 * offline verifier can deep-compare recomputed output against the stored row.
 *
 * For `cards` rows, `nonce` is the shuffle nonce of the shoe the cards came
 * from and `params` carries `{ deckCount, start, count }`.
 */
export function recomputeStoredRngDraw(input: {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  kind: StoredRngDrawKind;
  params: Record<string, unknown>;
}): Record<string, unknown> {
  if (input.kind === "cards") {
    const deckCount = requirePositiveInt(input.params.deckCount, "deckCount");
    const start = requireSafeInt(input.params.start, "start");
    const count = requirePositiveInt(input.params.count, "count");
    const cards = deckCardsAt({
      serverSeed: input.serverSeed,
      clientSeed: input.clientSeed,
      shuffleNonce: input.nonce,
      deckCount,
      start,
      count
    });
    return { kind: "cards", cards, deckCount, start, count };
  }
  const outcome = computeRngOutcome({
    serverSeed: input.serverSeed,
    clientSeed: input.clientSeed,
    nonce: input.nonce,
    kind: input.kind,
    params: input.params as RngDrawParams
  });
  return outcome as unknown as Record<string, unknown>;
}

export function formatRngOutcome(outcome: RngOutcome): string {
  switch (outcome.kind) {
    case "integers":
      return outcome.values.join(", ");
    case "dice":
      return outcome.values.length > 1 ? `${outcome.values.join(" + ")} = ${outcome.total}` : String(outcome.total);
    case "coin":
      return outcome.values.join(", ");
    case "pick":
      return outcome.values.join(", ");
    case "shuffle":
      return `shuffled ${outcome.permutation.length} items`;
  }
}

function requirePositiveInt(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function requireSafeInt(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}
