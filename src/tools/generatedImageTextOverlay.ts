import sharp from "sharp";
import type { ImageResult } from "../models/openrouter.js";

const MAX_FALLBACK_IMAGE_BYTES = 20 * 1024 * 1024;
const FALLBACK_IMAGE_TIMEOUT_MS = 15_000;
const MAX_FALLBACK_INPUT_PIXELS = 40_000_000;

export function imageTextOverlayBasePrompt(prompt: string) {
  return [
    prompt,
    "",
    "Typography fallback base: preserve the requested visual composition and any reference-image styling,",
    "but render no readable text, letters, numbers, logos, signage, captions, or placeholder glyphs anywhere.",
    "Ignore any earlier instruction to draw text. Leave the lower portion visually simple so exact typography can be added by code.",
  ].join("\n");
}

export async function renderExactImageTextOverlay(
  data: ImageResult["data"],
  requiredText: string[],
): Promise<Buffer | undefined> {
  const source = await firstGeneratedImageBuffer(data);
  if (!source) return undefined;

  const normalized = await sharp(source, {
    pages: 1,
    limitInputPixels: MAX_FALLBACK_INPUT_PIXELS,
  })
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true });
  const width = normalized.info.width;
  const height = normalized.info.height;
  if (!width || !height) return undefined;

  const typography = typographyLayout(width, height, requiredText);
  const panel = Buffer.from([
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${typography.panelHeight}">`,
    `<rect width="${width}" height="${typography.panelHeight}" fill="#080b12" fill-opacity="0.9"/>`,
    `<text x="${Math.round(width / 2)}" text-anchor="middle" fill="#ffffff"`,
    ` font-family="sans-serif" font-weight="700" font-size="${typography.fontSize}"`,
    ` stroke="#080b12" stroke-width="${Math.max(1, Math.round(typography.fontSize / 16))}" paint-order="stroke">`,
    ...requiredText.map((text, index) => (
      `<tspan x="${Math.round(width / 2)}" y="${typography.firstBaseline + (index * typography.lineHeight)}">` +
      `${escapeXml(text)}</tspan>`
    )),
    "</text>",
    "</svg>",
  ].join(""));

  return sharp(normalized.data, { limitInputPixels: MAX_FALLBACK_INPUT_PIXELS })
    .composite([{
      input: panel,
      left: 0,
      top: height - typography.panelHeight,
    }])
    .png()
    .toBuffer();
}

function typographyLayout(width: number, height: number, requiredText: string[]) {
  const itemCount = Math.max(1, requiredText.length);
  const padding = Math.max(16, Math.round(Math.min(width, height) * 0.035));
  const longestTextLength = Math.max(1, ...requiredText.map((text) => [...text].length));
  const widthLimitedFont = Math.floor((width - (padding * 2)) / (longestTextLength * 0.62));
  const heightLimitedFont = Math.floor((height * 0.42) / (itemCount * 1.35));
  const fontSize = Math.max(12, Math.min(64, widthLimitedFont, heightLimitedFont));
  const lineHeight = Math.max(fontSize + 4, Math.round(fontSize * 1.35));
  const panelHeight = Math.min(height, (padding * 2) + (lineHeight * itemCount));
  return {
    fontSize,
    lineHeight,
    panelHeight,
    firstBaseline: padding + fontSize,
  };
}

async function firstGeneratedImageBuffer(data: ImageResult["data"]) {
  for (const item of data) {
    if (item.b64_json) {
      const buffer = Buffer.from(item.b64_json, "base64");
      if (buffer.length <= MAX_FALLBACK_IMAGE_BYTES) return buffer;
      continue;
    }
    if (!item.url) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FALLBACK_IMAGE_TIMEOUT_MS);
    try {
      const response = await fetch(item.url, { signal: controller.signal });
      if (!response.ok) continue;
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_FALLBACK_IMAGE_BYTES) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_FALLBACK_IMAGE_BYTES) continue;
      return buffer;
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return undefined;
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character] ?? character);
}
