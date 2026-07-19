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

  it("recovers a durable delivery intent even if shutdown left the execution running", async () => {
    const file = Buffer.from("result");
    const intent = createDiscordDeliveryIntent({
      deliveryKey: "request-1",
      requesterUserId: "user-1",
      content: "done",
      presentation: { version: 1, audience: "requester", components: [{ type: "text", content: "Rich" }] },
      files: [{ artifactId: "artifact-1", name: "result.txt", sizeBytes: file.length, sha256: "f6a214f7a5fcda0c2cee9660b7fc29f5649e3c68aad48e20e950137c98913a68", contentType: "text/plain" }],
    });
    expect(decideDiscordDeliverySweep({ execution: { status: "running", error: null, metadata: {} }, deliveryIntent: intent })).toEqual({
      action: "deliver_intent",
      intent,
    });
    const decoded = parseDiscordDeliveryIntent(serializeDiscordDeliveryIntent(intent));
    await expect(discordDeliveryIntentFiles(decoded, async () => file)).resolves.toEqual([{ name: "result.txt", data: file, contentType: "text/plain" }]);
  });

  it("stores only explicitly redacted response text in a durable intent", () => {
    const intent = createDiscordDeliveryIntent({ deliveryKey: "request-1", requesterUserId: "user-1", content: "private original", storedContent: "[redacted]" });
    expect(intent).toEqual(expect.objectContaining({ content: "[redacted]", storedContent: "[redacted]", responseRedacted: true }));
    expect(serializeDiscordDeliveryIntent(intent)).not.toContain("private original");
  });

  it("keeps v1 base64 delivery intents readable across the cutover", async () => {
    const intent = parseDiscordDeliveryIntent({
      schemaVersion: 1,
      deliveryKey: "legacy",
      requesterUserId: "user-1",
      content: "done",
      storedContent: "done",
      responseRedacted: false,
      footer: null,
      presentation: null,
      files: [{ name: "legacy.txt", contentType: "text/plain", dataBase64: Buffer.from("legacy").toString("base64") }],
      sourceMessageReaction: null,
    });
    await expect(discordDeliveryIntentFiles(intent)).resolves.toEqual([{ name: "legacy.txt", contentType: "text/plain", data: Buffer.from("legacy") }]);
  });

  it("rejects corrupted binary delivery artifacts", async () => {
    const intent = createDiscordDeliveryIntent({
      deliveryKey: "request-1",
      requesterUserId: "user-1",
      content: "done",
      files: [{ artifactId: "artifact-1", name: "result.txt", sizeBytes: 6, sha256: "f6a214f7a5fcda0c2cee9660b7fc29f5649e3c68aad48e20e950137c98913a68" }],
    });
    await expect(discordDeliveryIntentFiles(intent, async () => Buffer.from("broken"))).rejects.toThrow("checksum");
  });

  it("abandons an orphaned obligation when its execution is missing", () => {
    const decision = decideDiscordDeliverySweep({ execution: null, finalText: null });
    expect(decision.action).toBe("abandon");
    if (decision.action !== "abandon") throw new Error("expected abandon decision");
    expect(decision.content).toContain("restarted");
    expect(decision.error).toContain("missing");
  });
});
