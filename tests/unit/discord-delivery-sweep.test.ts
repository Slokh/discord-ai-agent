import { describe, expect, it } from "vitest";
import { decideDiscordDeliverySweep } from "../../src/discord/deliverySweep.js";
import { createDiscordDeliveryIntent, discordDeliveryIntentFiles, parseDiscordDeliveryIntent, serializeDiscordDeliveryIntent } from "../../src/discord/deliveryIntent.js";

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

  it.each(["queued", "running"] as const)("leaves %s executions pending during a rolling deploy", (status) => {
    expect(decideDiscordDeliverySweep({ execution: { status, error: null, metadata: {} }, finalText: null }))
      .toEqual({ action: "wait" });
  });

  it("recovers a durable delivery intent even if shutdown left the execution running", () => {
    const intent = createDiscordDeliveryIntent({
      content: "done",
      presentation: { version: 1, audience: "requester", components: [{ type: "text", content: "Rich" }] },
      files: [{ name: "result.txt", data: Buffer.from("result"), contentType: "text/plain" }],
    });
    expect(decideDiscordDeliverySweep({ execution: { status: "running", error: null, metadata: {} }, deliveryIntent: intent })).toEqual({
      action: "deliver_intent",
      intent,
    });
    const decoded = parseDiscordDeliveryIntent(serializeDiscordDeliveryIntent(intent));
    expect(discordDeliveryIntentFiles(decoded)).toEqual([{ name: "result.txt", data: Buffer.from("result"), contentType: "text/plain" }]);
  });

  it("stores only explicitly redacted response text in a durable intent", () => {
    const intent = createDiscordDeliveryIntent({ content: "private original", storedContent: "[redacted]" });
    expect(intent).toEqual(expect.objectContaining({ content: "[redacted]", storedContent: "[redacted]", responseRedacted: true }));
    expect(serializeDiscordDeliveryIntent(intent)).not.toContain("private original");
  });

  it("abandons an orphaned obligation when its execution is missing", () => {
    const decision = decideDiscordDeliverySweep({ execution: null, finalText: null });
    expect(decision.action).toBe("abandon");
    if (decision.action !== "abandon") throw new Error("expected abandon decision");
    expect(decision.content).toContain("restarted");
    expect(decision.error).toContain("missing");
  });
});
