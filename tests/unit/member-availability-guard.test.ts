import { describe, expect, it } from "vitest";
import { shouldRejectUnsupportedMemberAvailability } from "../../src/agent/memberAvailabilityGuard.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("member availability guard", () => {
  const mentionedMemberContext = {
    mentionedUserIds: ["member-1"],
  } as unknown as ToolContext;

  it("rejects precise future-presence claims inferred from a member mention", () => {
    expect(shouldRejectUnsupportedMemberAvailability(
      mentionedMemberContext,
      "Avery should be online within the next two hours and will be playing by tonight.",
    )).toBe(true);
  });

  it("allows uncertainty and prompts the member to confirm directly", () => {
    expect(shouldRejectUnsupportedMemberAvailability(
      mentionedMemberContext,
      "I can't know their availability from a mention alone. Ask them to confirm a concrete time.",
    )).toBe(false);
  });

  it("does not capture answers when no other member was mentioned", () => {
    expect(shouldRejectUnsupportedMemberAvailability(
      { mentionedUserIds: [] } as unknown as ToolContext,
      "Avery should be online within the next two hours.",
    )).toBe(false);
  });
});
