import { describe, expect, it } from "vitest";
import {
  conversationMessagesFromEnvelope,
  deserializeAgentResponse,
  serializeAgentResponse
} from "../../src/agent/sandboxPromptProtocol.js";

describe("sandbox prompt protocol", () => {
  it("serializes files and restores conversation messages", () => {
    const serialized = serializeAgentResponse({
      content: "hello",
      files: [{ name: "image.png", contentType: "image/png", data: Buffer.from("png") }],
      memoryEvents: [{ role: "tool", content: "tool result", metadata: { tool: "example" } }]
    });

    expect(serialized).toEqual({
      content: "hello",
      files: [{ name: "image.png", contentType: "image/png", dataBase64: Buffer.from("png").toString("base64") }],
      memoryEvents: [{ role: "tool", content: "tool result", metadata: { tool: "example" } }]
    });
    expect(deserializeAgentResponse(serialized)).toEqual({
      content: "hello",
      files: [{ name: "image.png", contentType: "image/png", data: Buffer.from("png") }],
      memoryEvents: [{ role: "tool", content: "tool result", metadata: { tool: "example" } }]
    });

    expect(
      conversationMessagesFromEnvelope({
        sessionMessages: [
          {
            id: 1,
            threadKey: "discord:guild:channel",
            discordMessageId: "message-1",
            role: "user",
            authorId: "user",
            authorDisplayName: "Kartik",
            content: "prior",
            parts: [],
            metadata: { ok: true },
            createdAt: "2026-07-01T12:00:00.000Z"
          }
        ]
      } as never)
    ).toEqual([
      expect.objectContaining({
        id: 1,
        content: "prior",
        createdAt: new Date("2026-07-01T12:00:00.000Z")
      })
    ]);
  });
});
