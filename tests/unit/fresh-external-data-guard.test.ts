import { describe, expect, it } from "vitest";
import { hasFreshExternalToolEvidence, requiresFreshExternalData, shouldRejectUngroundedFreshData } from "../../src/agent/freshExternalDataGuard.js";

describe("fresh external data guard", () => {
  it("requires fresh evidence for natural-language live flight shopping", () => {
    const prompt = "Find the cheapest nonstop round-trip flights from NYC to Japan this fall.";
    expect(requiresFreshExternalData(prompt)).toBe(true);
    expect(shouldRejectUngroundedFreshData({
      userText: prompt,
      responseContent: "United is cheapest at $841 round-trip on September 16.",
      freshEvidenceObserved: false,
    })).toBe(true);
  });

  it("allows grounded results and concise clarification questions", () => {
    const prompt = "Find the cheapest nonstop round-trip flights from NYC to Japan this fall.";
    expect(shouldRejectUngroundedFreshData({
      userText: prompt,
      responseContent: "Verified current result from the flight service.",
      freshEvidenceObserved: true,
    })).toBe(false);
    expect(shouldRejectUngroundedFreshData({
      userText: prompt,
      responseContent: "How long should the trip be? I need a trip length to compare round trips.",
      freshEvidenceObserved: false,
    })).toBe(false);
  });

  it("does not allow an unverifiable fare range hidden behind a disclaimer", () => {
    const prompt = "Find the cheapest nonstop round-trip flights from NYC to Japan this fall.";
    expect(shouldRejectUngroundedFreshData({
      userText: prompt,
      responseContent: "I couldn't verify live results. Typical fares are $900–$1,400.",
      freshEvidenceObserved: false,
    })).toBe(true);
  });

  it("allows a concise provider failure after a live lookup cannot complete", () => {
    expect(shouldRejectUngroundedFreshData({
      userText: "Find the cheapest flights this fall",
      responseContent: "I can't pull live flight prices right now because the paid provider failed before returning results.",
      freshEvidenceObserved: false,
    })).toBe(false);
  });

  it("does not interfere with timeless price explanations", () => {
    expect(requiresFreshExternalData("Explain how airlines price connecting flights."))
      .toBe(false);
  });

  it("does not mistake local game odds for time-sensitive external data", () => {
    expect(requiresFreshExternalData(
      "Get me on top by one cent with a complicated dice game where I have the best odds to win.",
    )).toBe(false);
  });

  it("still requires fresh evidence for live betting odds", () => {
    expect(requiresFreshExternalData("Find the best live betting odds for tonight's game."))
      .toBe(true);
  });

  it("requires structured citations instead of treating a search attempt as usable evidence", () => {
    expect(hasFreshExternalToolEvidence({
      serverToolUse: { web_search_requests: 1, tool_calls_executed: 1 },
      urlCitations: [],
    })).toBe(false);
    expect(hasFreshExternalToolEvidence({
      serverToolUse: { web_search_requests: 1, tool_calls_executed: 1 },
      urlCitations: [{ url: "https://example.com/current-odds" }],
    })).toBe(true);
    expect(hasFreshExternalToolEvidence({
      urlCitations: [{ url: "https://example.com/current-odds" }],
    })).toBe(false);
  });
});
