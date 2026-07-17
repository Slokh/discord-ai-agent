import { describe, expect, it } from "vitest";
import { compactMessagesForModelFallback } from "../../src/agent/modelTimeoutFallback.js";
import type { ChatMessage } from "../../src/models/openrouter.js";

describe("model timeout fallback", () => {
  it("keeps system context and the current request while dropping oldest conversation history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "base instructions" },
      { role: "system", content: "Current Discord requester: User (u)" },
      { role: "user", content: `old question ${"x".repeat(300)}` },
      { role: "assistant", content: `old answer ${"y".repeat(300)}` },
      { role: "user", content: `recent question ${"a".repeat(120)}` },
      { role: "assistant", content: `recent answer ${"b".repeat(120)}` },
      { role: "user", content: "current request" },
    ];

    const compacted = compactMessagesForModelFallback(messages, 650);

    expect(compacted[0]).toEqual(messages[0]);
    expect(compacted).toContainEqual(messages[1]);
    expect(compacted.at(-1)).toEqual(messages.at(-1));
    expect(compacted).toContainEqual(messages[5]);
    expect(compacted).not.toContainEqual(messages[2]);
    expect(compacted.map((message) => messages.indexOf(message)))
      .toEqual([...compacted.map((message) => messages.indexOf(message))].sort((a, b) => a - b));
  });
});
