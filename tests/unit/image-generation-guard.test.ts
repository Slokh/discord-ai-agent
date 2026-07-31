import { describe, expect, it } from "vitest";
import {
  hasExplicitImageGenerationIntent,
  ImageGenerationGuard,
} from "../../src/agent/imageGenerationGuard.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("image generation guard", () => {
  it("recognizes direct generation and retained-context visual follow-ups", () => {
    expect(hasExplicitImageGenerationIntent(
      { requestAttachments: [], sessionMessages: [] },
      "Create a synthetic landscape image.",
    )).toBe(true);
    expect(hasExplicitImageGenerationIntent(
      {
        requestAttachments: [],
        sessionMessages: [{
          content: "Create a synthetic landscape image.",
          metadata: {},
        }],
      } as unknown as ToolContext,
      "make it brighter",
    )).toBe(true);
    expect(hasExplicitImageGenerationIntent(
      {
        requestAttachments: [],
        replyContext: {
          chain: [{
            attachments: [{
              id: "synthetic-reference",
              url: "https://cdn.discordapp.com/synthetic-reference.png",
              filename: "synthetic-reference.png",
              contentType: "image/png",
            }],
          }],
        },
        sessionMessages: [],
      } as unknown as ToolContext,
      "No, it should keep the same synthetic subject.",
    )).toBe(true);
    expect(hasExplicitImageGenerationIntent(
      {
        requestAttachments: [],
        replyContext: {
          chain: [{
            attachments: [{
              id: "synthetic-reference",
              url: "https://cdn.discordapp.com/synthetic-reference.png",
              filename: "synthetic-reference.png",
              contentType: "image/png",
            }],
          }],
        },
        sessionMessages: [],
      } as unknown as ToolContext,
      "The new result is not the same person as the reference.",
    )).toBe(true);
  });

  it("does not turn image how-to questions or unrelated edits into generation", () => {
    expect(hasExplicitImageGenerationIntent(
      { requestAttachments: [], sessionMessages: [] },
      "How do I create an image with transparent pixels?",
    )).toBe(false);
    expect(hasExplicitImageGenerationIntent(
      { requestAttachments: [], sessionMessages: [] },
      "make it faster",
    )).toBe(false);
  });

  it("does not retry after a real generation attempt", async () => {
    const guard = new ImageGenerationGuard(
      { requestAttachments: [] } as unknown as ToolContext,
      "Create a synthetic landscape image.",
    );

    await expect(guard.retryDraft(
      "The provider rejected the request.",
      [],
      2,
      true,
    )).resolves.toBe(false);
  });
});
