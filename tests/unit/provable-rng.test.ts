import { describe, expect, it } from "vitest";
import {
  CARDS_PER_DECK,
  computeRngOutcome,
  createRngStream,
  deckCardsAt,
  formatRngOutcome,
  generateServerSeed,
  recomputeStoredRngDraw,
  referenceDeckCard,
  rngCommitment,
  uniformInt,
  uniformPermutation,
  verifyRngCommitment
} from "../../src/rng/provable.js";

const SERVER_SEED = "aa".repeat(32);
const CLIENT_SEED = "1234567890123456789";

describe("commitment", () => {
  it("commits and verifies a server seed", () => {
    const seed = generateServerSeed();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    const commitment = rngCommitment(seed);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRngCommitment(seed, commitment)).toBe(true);
    expect(verifyRngCommitment(seed, commitment.toUpperCase())).toBe(true);
    expect(verifyRngCommitment(generateServerSeed(), commitment)).toBe(false);
    expect(verifyRngCommitment(seed, "not-hex")).toBe(false);
    expect(verifyRngCommitment(seed, "abcd")).toBe(false);
  });

  it("produces a stable commitment for a known seed", () => {
    expect(rngCommitment(SERVER_SEED)).toBe(rngCommitment(SERVER_SEED));
    expect(rngCommitment(SERVER_SEED)).not.toBe(rngCommitment("bb".repeat(32)));
  });
});

describe("createRngStream", () => {
  it("is deterministic for identical inputs", () => {
    const a = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0 });
    const b = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0 });
    const valuesA = Array.from({ length: 20 }, () => a.nextUint32());
    const valuesB = Array.from({ length: 20 }, () => b.nextUint32());
    expect(valuesA).toEqual(valuesB);
  });

  it("diverges when the nonce differs", () => {
    const a = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0 });
    const b = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 1 });
    expect(a.nextUint32()).not.toBe(b.nextUint32());
  });

  it("diverges when the client seed differs", () => {
    const a = createRngStream({ serverSeed: SERVER_SEED, clientSeed: "x", nonce: 0 });
    const b = createRngStream({ serverSeed: SERVER_SEED, clientSeed: "y", nonce: 0 });
    expect(a.nextUint32()).not.toBe(b.nextUint32());
  });
});

describe("uniformInt", () => {
  it("stays within bounds and covers a small range", () => {
    const stream = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0 });
    const seen = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      const value = uniformInt(stream, 1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect(seen.size).toBe(6);
  });

  it("handles a single-value range and rejects invalid ranges", () => {
    const stream = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0 });
    expect(uniformInt(stream, 5, 5)).toBe(5);
    expect(() => uniformInt(stream, 6, 5)).toThrow();
    expect(() => uniformInt(stream, 0, 2 ** 33)).toThrow();
  });
});

describe("uniformPermutation", () => {
  it("returns a valid deterministic permutation", () => {
    const streamA = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 3 });
    const streamB = createRngStream({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 3 });
    const a = uniformPermutation(streamA, 52);
    const b = uniformPermutation(streamB, 52);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 52 }, (_, i) => i));
  });
});

describe("computeRngOutcome", () => {
  it("computes dice with a total", () => {
    const outcome = computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0, kind: "dice", params: { count: 2, sides: 6 } });
    if (outcome.kind !== "dice") throw new Error("expected dice");
    expect(outcome.values).toHaveLength(2);
    for (const value of outcome.values) {
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
    }
    expect(outcome.total).toBe(outcome.values[0] + outcome.values[1]);
  });

  it("computes integers within range", () => {
    const outcome = computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 1, kind: "integers", params: { count: 5, min: -3, max: 3 } });
    if (outcome.kind !== "integers") throw new Error("expected integers");
    expect(outcome.values).toHaveLength(5);
    for (const value of outcome.values) {
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThanOrEqual(3);
    }
  });

  it("computes coins, picks, and shuffles", () => {
    const coin = computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 2, kind: "coin", params: { count: 3 } });
    if (coin.kind !== "coin") throw new Error("expected coin");
    expect(coin.values).toHaveLength(3);
    for (const value of coin.values) expect(["heads", "tails"]).toContain(value);

    const pick = computeRngOutcome({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      nonce: 3,
      kind: "pick",
      params: { count: 2, options: ["alice", "bob", "carol"] }
    });
    if (pick.kind !== "pick") throw new Error("expected pick");
    expect(pick.values).toHaveLength(2);
    expect(new Set(pick.values).size).toBe(2);
    for (const value of pick.values) expect(["alice", "bob", "carol"]).toContain(value);

    const shuffle = computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 4, kind: "shuffle", params: { size: 5 } });
    if (shuffle.kind !== "shuffle") throw new Error("expected shuffle");
    expect([...shuffle.permutation].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("rejects invalid parameters", () => {
    expect(() =>
      computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0, kind: "pick", params: { count: 4, options: ["a", "b"] } })
    ).toThrow();
    expect(() => computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0, kind: "integers", params: { count: 1 } })).toThrow();
    expect(() => computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0, kind: "dice", params: { count: 0 } })).toThrow();
  });
});

describe("reference deck", () => {
  it("maps indexes to cards in suit blocks", () => {
    expect(referenceDeckCard(0)).toBe("A♠");
    expect(referenceDeckCard(12)).toBe("K♠");
    expect(referenceDeckCard(13)).toBe("A♥");
    expect(referenceDeckCard(51)).toBe("K♣");
    expect(referenceDeckCard(52)).toBe("A♠");
  });
});

describe("deckCardsAt", () => {
  it("deals a full single deck without replacement", () => {
    const cards: string[] = [];
    for (let start = 0; start < CARDS_PER_DECK; start += 13) {
      cards.push(...deckCardsAt({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, shuffleNonce: 0, deckCount: 1, start, count: 13 }));
    }
    expect(cards).toHaveLength(52);
    expect(new Set(cards).size).toBe(52);
  });

  it("deals each card exactly twice from a two-deck shoe", () => {
    const cards = deckCardsAt({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, shuffleNonce: 0, deckCount: 2, start: 0, count: 104 });
    const counts = new Map<string, number>();
    for (const card of cards) counts.set(card, (counts.get(card) ?? 0) + 1);
    expect(counts.size).toBe(52);
    for (const count of counts.values()) expect(count).toBe(2);
  });

  it("is consistent across overlapping slices", () => {
    const all = deckCardsAt({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, shuffleNonce: 5, deckCount: 1, start: 0, count: 52 });
    const slice = deckCardsAt({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, shuffleNonce: 5, deckCount: 1, start: 10, count: 5 });
    expect(slice).toEqual(all.slice(10, 15));
  });

  it("rejects out-of-range slices", () => {
    expect(() => deckCardsAt({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, shuffleNonce: 0, deckCount: 1, start: 50, count: 5 })).toThrow();
    expect(() => deckCardsAt({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, shuffleNonce: 0, deckCount: 1, start: -1, count: 1 })).toThrow();
  });
});

describe("recomputeStoredRngDraw", () => {
  it("round-trips basic draws through JSON like the database does", () => {
    const outcome = computeRngOutcome({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 7, kind: "dice", params: { count: 2, sides: 20 } });
    const stored = JSON.parse(JSON.stringify(outcome));
    const recomputed = recomputeStoredRngDraw({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 7, kind: "dice", params: { count: 2, sides: 20 } });
    expect(JSON.parse(JSON.stringify(recomputed))).toEqual(stored);
  });

  it("recomputes card slices from the shoe shuffle nonce", () => {
    const cards = deckCardsAt({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, shuffleNonce: 2, deckCount: 1, start: 4, count: 3 });
    const recomputed = recomputeStoredRngDraw({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      nonce: 2,
      kind: "cards",
      params: { deckCount: 1, start: 4, count: 3 }
    });
    expect(recomputed).toEqual({ kind: "cards", cards, deckCount: 1, start: 4, count: 3 });
  });

  it("detects tampered outcomes", () => {
    const params = { count: 2, sides: 6 };
    const honest = recomputeStoredRngDraw({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0, kind: "dice", params });
    const tampered = { ...honest, values: [6, 6], total: 12 };
    const recomputed = recomputeStoredRngDraw({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, nonce: 0, kind: "dice", params });
    expect(JSON.stringify(recomputed)).toBe(JSON.stringify(honest));
    if (JSON.stringify(honest) !== JSON.stringify(tampered)) {
      expect(JSON.stringify(recomputed)).not.toBe(JSON.stringify(tampered));
    }
  });
});

describe("formatRngOutcome", () => {
  it("formats each outcome kind", () => {
    expect(formatRngOutcome({ kind: "integers", values: [4, 2] })).toBe("4, 2");
    expect(formatRngOutcome({ kind: "dice", values: [3, 5], total: 8 })).toBe("3 + 5 = 8");
    expect(formatRngOutcome({ kind: "dice", values: [6], total: 6 })).toBe("6");
    expect(formatRngOutcome({ kind: "coin", values: ["heads"] })).toBe("heads");
    expect(formatRngOutcome({ kind: "pick", values: ["alice"] })).toBe("alice");
    expect(formatRngOutcome({ kind: "shuffle", permutation: [1, 0, 2] })).toBe("shuffled 3 items");
  });
});
