import { describe, expect, it } from "vitest";

import { checkProtocolInvariants } from "../../scripts/verify-rng.js";

type Draw = { id: number; nonce: number; kind: string; params: Record<string, unknown> };

let nextId = 1;

function draw(nonce: number, kind: string, params: Record<string, unknown> = {}): Draw {
  return { id: nextId++, nonce, kind, params };
}

function shoeShuffle(nonce: number, deckCount: number): Draw {
  return draw(nonce, "shuffle", { shoe: true, deckCount, size: deckCount * 52 });
}

function cards(shuffleNonce: number, deckCount: number, start: number, count: number): Draw {
  return draw(shuffleNonce, "cards", { deckCount, start, count });
}

describe("checkProtocolInvariants", () => {
  it("accepts an empty session", () => {
    expect(checkProtocolInvariants(0, [])).toEqual([]);
  });

  it("accepts a clean transcript with entropy draws and shoe-dealt cards", () => {
    const draws = [
      draw(0, "dice", { count: 2, sides: 6 }),
      shoeShuffle(1, 1),
      cards(1, 1, 0, 2),
      cards(1, 1, 2, 3),
      draw(2, "coin", { count: 1 })
    ];
    expect(checkProtocolInvariants(3, draws)).toEqual([]);
  });

  it("flags a skipped nonce (entropy consumed without a recorded draw)", () => {
    const problems = checkProtocolInvariants(2, [draw(1, "dice", { sides: 6 })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nonces 0..1");
  });

  it("flags a duplicated nonce across entropy draws", () => {
    const problems = checkProtocolInvariants(2, [
      draw(0, "dice", { sides: 6 }),
      draw(0, "coin", {}),
      draw(1, "coin", {})
    ]);
    expect(problems).toHaveLength(1);
  });

  it("flags a cards row whose shoe shuffle was never recorded", () => {
    const problems = checkProtocolInvariants(0, [cards(5, 1, 0, 2)]);
    expect(problems.some((problem) => problem.includes("never recorded"))).toBe(true);
  });

  it("flags a cards row whose deck count disagrees with the recorded shoe", () => {
    const problems = checkProtocolInvariants(1, [shoeShuffle(0, 2), cards(0, 1, 0, 2)]);
    expect(problems.some((problem) => problem.includes("deck count 1"))).toBe(true);
  });

  it("flags overlapping card slices (same card dealt twice)", () => {
    const problems = checkProtocolInvariants(1, [shoeShuffle(0, 1), cards(0, 1, 0, 3), cards(0, 1, 2, 2)]);
    expect(problems.some((problem) => problem.includes("position 3"))).toBe(true);
  });

  it("flags a gap in card slices (skipped cards)", () => {
    const problems = checkProtocolInvariants(1, [shoeShuffle(0, 1), cards(0, 1, 0, 2), cards(0, 1, 5, 2)]);
    expect(problems.some((problem) => problem.includes("position 2"))).toBe(true);
  });

  it("flags dealing past the end of the shoe", () => {
    const problems = checkProtocolInvariants(1, [shoeShuffle(0, 1), cards(0, 1, 0, 53)]);
    expect(problems.some((problem) => problem.includes("past the end"))).toBe(true);
  });

  it("tracks multiple shoes independently", () => {
    const draws = [shoeShuffle(0, 1), cards(0, 1, 0, 2), shoeShuffle(1, 2), cards(1, 2, 0, 4), cards(1, 2, 4, 1)];
    expect(checkProtocolInvariants(2, draws)).toEqual([]);
  });
});
