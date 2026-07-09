import { describe, expect, it } from "vitest";
import { buildConversationSummaryPrompt } from "../../src/db/conversationCompaction.js";

describe("conversation compaction helpers", () => {
  it("builds a bounded summarization prompt from chronological messages", () => {
    const prompt = buildConversationSummaryPrompt([
      { role: "user", authorDisplayName: "User", content: "remember I prefer concise answers", createdAt: new Date("2026-01-01T00:00:00Z") },
      { role: "assistant", authorDisplayName: "ai", content: "Got it.", createdAt: new Date("2026-01-01T00:00:01Z") }
    ]);

    expect(prompt).toContain("Summarize these older Discord agent conversation turns");
    expect(prompt).toContain("user User: remember I prefer concise answers");
    expect(prompt).toContain("assistant ai: Got it.");
  });
});
