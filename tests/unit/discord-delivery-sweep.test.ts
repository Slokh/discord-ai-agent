import { describe, expect, it } from "vitest";
import { decideDiscordDeliverySweep } from "../../src/discord/deliverySweep.js";

describe("decideDiscordDeliverySweep", () => {
  it("delivers terminal executions with stored response text", () => {
    expect(decideDiscordDeliverySweep({ execution: { status: "succeeded", error: null, metadata: {} }, finalText: "done" })).toEqual({ action: "deliver", content: "done" });
  });

  it("marks already-delivered executions without re-sending", () => {
    expect(
      decideDiscordDeliverySweep({
        execution: { status: "succeeded", error: null, metadata: { replyMessageId: "reply-message-1", replyUrl: "https://discord.com/..." } },
        finalText: "done"
      })
    ).toEqual({ action: "already_delivered", replyMessageId: "reply-message-1" });
  });

  it("ignores blank replyMessageId metadata and still delivers stored text", () => {
    expect(decideDiscordDeliverySweep({ execution: { status: "succeeded", error: null, metadata: { replyMessageId: "  " } }, finalText: "done" })).toEqual({
      action: "deliver",
      content: "done"
    });
  });

  it("abandons stale non-terminal executions with a restart notice", () => {
    const decision = decideDiscordDeliverySweep({ execution: { status: "running", error: null, metadata: {} }, finalText: null });
    expect(decision.action).toBe("abandon");
    if (decision.action !== "abandon") throw new Error("expected abandon decision");
    expect(decision.content).toContain("restarted");
  });
});
