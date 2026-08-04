import { describe, expect, it } from "vitest";
import { privateFeedbackReplaySkipReason } from "../../src/observability/privateFeedbackReplay.js";

describe("private feedback replay", () => {
  const replayable = { hasAssertion: true, hasReplayScope: true, expectedTools: [] };

  it("requires an assertion and replay scope", () => {
    expect(privateFeedbackReplaySkipReason({ ...replayable, hasAssertion: false }))
      .toContain("Reviewer must add");
    expect(privateFeedbackReplaySkipReason({ ...replayable, hasReplayScope: false }))
      .toContain("visible-channel scope");
  });

  it("does not auto-grade file inspection without the original attachment", () => {
    expect(privateFeedbackReplaySkipReason({ ...replayable, expectedTools: ["inspectDiscordFile"] }))
      .toContain("attachments");
  });

  it("keeps faithful cases eligible for automated grading", () => {
    expect(privateFeedbackReplaySkipReason(replayable)).toBeNull();
  });
});
