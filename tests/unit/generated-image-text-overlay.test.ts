import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  imageTextOverlayBasePrompt,
  imageTextOverlayLayout,
  renderExactImageTextOverlay,
} from "../../src/tools/generatedImageTextOverlay.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("generated image exact-text overlay", () => {
  it("keeps the visual request while overriding provider-rendered typography", () => {
    const prompt = imageTextOverlayBasePrompt("Keep the synthetic reference palette.");

    expect(prompt).toContain("Keep the synthetic reference palette.");
    expect(prompt).toContain("render no readable text");
    expect(prompt).toContain("exact typography can be added by code");
  });

  it("wraps long labels before shrinking text and keeps the caption panel within the image", () => {
    const layout = imageTextOverlayLayout(360, 180, [
      "A descriptive chart label that needs multiple readable lines",
      "Second legend label",
    ]);

    expect(layout.lines).toHaveLength(3);
    expect(layout.lines.slice(0, 2).join("")).toBe("A descriptive chart label that needs multiple readable lines");
    expect(layout.lines[2]).toBe("Second legend label");
    expect(layout.fontSize).toBeGreaterThanOrEqual(16);
    expect(layout.panelHeight).toBeLessThanOrEqual(180);
  });

  it("renders XML-sensitive exact text onto a URL-backed generated image", async () => {
    const generatedImage = await sharp({
      create: {
        width: 720,
        height: 480,
        channels: 3,
        background: { r: 18, g: 40, b: 70 },
      },
    }).png().toBuffer();
    const fetchMock = vi.fn(async () => new Response(generatedImage, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(generatedImage.length),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await renderExactImageTextOverlay(
      [{ url: "https://example.com/generated.png" }],
      ["SAFE & EXACT <TEXT>", '"PUBLIC" FIXTURE'],
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/generated.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toBeDefined();
    await expect(sharp(result!).metadata()).resolves.toMatchObject({
      width: 720,
      height: 480,
      format: "png",
    });
  });

  it("returns no fallback when every generated URL is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(renderExactImageTextOverlay(
      [{ url: "https://example.com/missing.png" }],
      ["SAFE FIXTURE"],
    )).resolves.toBeUndefined();
  });
});
