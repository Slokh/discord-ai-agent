import { describe, expect, it } from "vitest";
import {
  shouldForceContextImageInspection,
  shouldRetryFalseImageRefusal,
} from "../../src/agent/imageEvidenceGuard.js";
import { inferRequiredImageText } from "../../src/tools/generatedImageTextValidation.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("image evidence guard", () => {
  it("retries false refusals only when a visible context image exists", () => {
    const imageContext = {
      requestAttachments: [],
      replyContext: {
        chain: [{
          attachments: [{
            id: "synthetic-image",
            url: "https://cdn.discordapp.com/synthetic.png",
            filename: "synthetic.png",
            contentType: "image/png",
          }],
        }],
      },
    } as unknown as ToolContext;

    expect(shouldRetryFalseImageRefusal(
      imageContext,
      "I can't access the earlier image from this reply.",
    )).toBe(true);
    expect(shouldRetryFalseImageRefusal(
      { requestAttachments: [], replyContext: null } as unknown as ToolContext,
      "I can't access the earlier image from this reply.",
    )).toBe(false);
    expect(shouldRetryFalseImageRefusal(
      imageContext,
      "The image shows a synthetic chart.",
    )).toBe(false);
  });

  it("requires image evidence for causal follow-ups to a directly replied image", () => {
    const imageContext = {
      requestAttachments: [],
      replyContext: {
        chain: [{
          authorIsBot: true,
          content: "Here is the generated synthetic diagram.",
          attachments: [{
            id: "synthetic-image",
            url: "https://cdn.discordapp.com/synthetic.png",
            filename: "synthetic.png",
            contentType: "image/png",
          }],
        }],
      },
    } as unknown as ToolContext;

    expect(shouldForceContextImageInspection(
      imageContext,
      "Why did you put the blue marker there?",
    )).toBe(true);
    expect(shouldForceContextImageInspection(
      imageContext,
      "Thanks for making it.",
    )).toBe(false);
    expect(shouldForceContextImageInspection(
      { requestAttachments: [], replyContext: null } as unknown as ToolContext,
      "Why did you put the blue marker there?",
    )).toBe(false);
  });

  it("infers only explicitly cued visible text", () => {
    expect(inferRequiredImageText([
      "Create a racing poster titled APEX DAY 7429.",
      "Keep the title exact in the next version.",
    ])).toEqual(["APEX DAY 7429"]);
    expect(inferRequiredImageText([
      "Create a blue poster with a geometric skyline.",
    ])).toEqual([]);
  });
});
