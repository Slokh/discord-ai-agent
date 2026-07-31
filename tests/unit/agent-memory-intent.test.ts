import { describe, expect, it } from "vitest";
import { requiresAgentSelfHistory } from "../../src/tools/agentMemoryIntent.js";

describe("agent self-history intent", () => {
  it.each([
    "what did you just say?",
    "why did you call Taylor Maverick?",
    "I don't think you have ever called Taylor that",
    "you keep calling Taylor Maverick",
  ])("recognizes disputes and questions about the agent's own words: %s", (prompt) => {
    expect(requiresAgentSelfHistory(prompt)).toBe(true);
  });

  it.each([
    "why did you choose that tool?",
    "how did you calculate that?",
    "what did Taylor say?",
  ])("does not capture debugging, methodology, or human-history requests: %s", (prompt) => {
    expect(requiresAgentSelfHistory(prompt)).toBe(false);
  });
});
