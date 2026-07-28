import { describe, expect, it } from "vitest";
import {
  hasFreshExternalToolEvidence,
  hasRelativeDateContradiction,
  requiresFreshExternalData,
  shouldRejectUngroundedFreshData,
} from "../../src/agent/freshExternalDataGuard.js";

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

  it("requires fresh evidence for current sports rosters and this-season predictions", () => {
    expect(requiresFreshExternalData(
      "Predict the NBA Finals with current rosters.",
    )).toBe(true);
    expect(requiresFreshExternalData(
      "Who makes the NBA Finals this season?",
    )).toBe(true);
    expect(shouldRejectUngroundedFreshData({
      userText: "Predict the NBA Finals with current rosters.",
      responseContent: "Boston beats Denver in six based on the current lineups.",
      freshEvidenceObserved: false,
    })).toBe(true);
  });

  it("does not force current-data retrieval for timeless player rankings or team-building", () => {
    expect(requiresFreshExternalData("Who are the best NBA players ever?")).toBe(false);
    expect(requiresFreshExternalData("What is the best team-building exercise this week?")).toBe(false);
  });

  it("requires fresh evidence for natural time-to-launch and playability questions", () => {
    expect(requiresFreshExternalData("how much longer til i can play classic mode with my friend"))
      .toBe(true);
    expect(requiresFreshExternalData("when can we access the new season?"))
      .toBe(true);
    expect(requiresFreshExternalData("what time does the expansion launch?"))
      .toBe(true);
    expect(requiresFreshExternalData("when is the update coming out?"))
      .toBe(true);
  });

  it("rejects relative dates that contradict the explicit date in the same answer", () => {
    const now = new Date("2026-07-28T17:29:00.000Z");
    expect(hasRelativeDateContradiction("It launches today, July 29, 2026.", now)).toBe(true);
    expect(hasRelativeDateContradiction("It launches tomorrow, July 29, 2026.", now)).toBe(false);
    expect(hasRelativeDateContradiction("It launched yesterday, July 27.", now)).toBe(false);
    expect(shouldRejectUngroundedFreshData({
      userText: "when does the expansion launch?",
      responseContent: "Fresh results say it launches today, July 29, 2026.",
      freshEvidenceObserved: true,
      now,
    })).toBe(true);
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

  it("rejects a current catalog nonexistence claim when citations do not cover the denied item", () => {
    const prompt = "Nimbus Note X vs Nimbus Note Air vs Nimbus Note Pro for school";
    expect(shouldRejectUngroundedFreshData({
      userText: prompt,
      responseContent: 'There is no "Nimbus Note X"; compare the Air and Pro instead.',
      freshEvidenceObserved: true,
      urlCitations: [{
        url: "https://example.test/nimbus-note-air",
        title: "Nimbus Note Air",
      }],
    })).toBe(true);
    expect(shouldRejectUngroundedFreshData({
      userText: prompt,
      responseContent: 'There is no "Nimbus Note X" in the current catalog.',
      freshEvidenceObserved: true,
      urlCitations: [{
        url: "https://example.test/nimbus-note-x",
        title: "Nimbus Note X availability",
      }],
    })).toBe(false);
  });
});
