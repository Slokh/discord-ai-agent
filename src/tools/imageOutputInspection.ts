import sharp from "sharp";
import type { AgentFile } from "./types.js";

export async function generatedImageDimensions(file: AgentFile) {
  try {
    const metadata = await sharp(file.data, { pages: 1, limitInputPixels: 40_000_000 }).metadata();
    return metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null;
  } catch {
    return null;
  }
}

export async function describeGeneratedImageFile(file: AgentFile) {
  const contentType = file.contentType || "unknown image format";
  try {
    const { data, info } = await sharp(file.data, { pages: 1, limitInputPixels: 40_000_000 })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaOffset = info.channels - 1;
    let hasTransparentPixel = false;
    for (let index = alphaOffset; index < data.length; index += info.channels) {
      if (data[index] < 255) {
        hasTransparentPixel = true;
        break;
      }
    }
    const transparency = hasTransparentPixel ? "real alpha transparency" : "opaque";
    return `${contentType} (${transparency})`;
  } catch {
    return contentType;
  }
}
