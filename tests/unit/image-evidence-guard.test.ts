import { describe, expect, it } from "vitest";
import { shouldRetryFalseImageRefusal } from "../../src/agent/imageEvidenceGuard.js";
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
