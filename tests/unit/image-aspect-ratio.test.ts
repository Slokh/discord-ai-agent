import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  inferredImageAspectRatio,
} from "../../src/tools/imageAspectRatio.js";
import { generatedImageDimensions } from "../../src/tools/imageOutputInspection.js";

describe("image aspect ratio", () => {
  it.each([
    ["a portrait composition", "3:4"],
    ["a vertical character study", "3:4"],
    ["a landscape scene", "16:9"],
    ["a square icon", "1:1"],
    ["a portrait composition at 9:16", "9:16"],
    ["a neutral studio scene", undefined],
  ] as const)("infers an explicit canvas shape from %s", (prompt, expected) => {
    expect(inferredImageAspectRatio(prompt)).toBe(expected);
  });

  it("reads delivered image dimensions from the actual pixels", async () => {
    const data = await sharp({
      create: {
        width: 600,
        height: 800,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).png().toBuffer();

    await expect(generatedImageDimensions({
      name: "portrait.png",
      data,
      contentType: "image/png",
    })).resolves.toBe("600x800");
  });
});
