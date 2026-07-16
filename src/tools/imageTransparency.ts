import sharp from "sharp";
import type { AgentFile } from "./types.js";

export type TransparentImageNormalization = {
  file: AgentFile | null;
  backgroundRemoved: boolean;
};

export async function normalizeGeneratedTransparentImage(file: AgentFile): Promise<TransparentImageNormalization> {
  try {
    const decoded = await sharp(file.data, { pages: 1, limitInputPixels: 40_000_000 })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (rawImageHasTransparency(decoded.data, decoded.info.channels)) {
      return { file, backgroundRemoved: false };
    }
    const removed = removeBorderConnectedBackground(decoded.data, decoded.info);
    if (!removed) return { file: null, backgroundRemoved: false };
    const png = await sharp(removed.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels as 4
      }
    })
      .extract(removed.crop)
      .png()
      .toBuffer();
    return {
      file: {
        name: `${file.name.replace(/\.[^.]+$/, "") || "discord-ai-agent"}.png`,
        data: png,
        contentType: "image/png"
      },
      backgroundRemoved: true
    };
  } catch {
    return { file: null, backgroundRemoved: false };
  }
}

function removeBorderConnectedBackground(
  input: Buffer,
  info: { width: number; height: number; channels: number }
): { data: Buffer; crop: { left: number; top: number; width: number; height: number } } | null {
  const { width, height, channels } = info;
  if (width < 2 || height < 2 || channels < 4) return null;
  const border = sampleImageBorder(input, width, height, channels);
  if (border.length === 0) return null;
  const background = [0, 1, 2].map((channel) => median(border.map((pixel) => pixel[channel] ?? 0)));
  const borderDistances = border.map((pixel) => colorDistance(pixel, background)).sort((a, b) => a - b);
  const borderP95 = borderDistances[Math.min(borderDistances.length - 1, Math.floor(borderDistances.length * 0.95))] ?? 0;
  if (borderP95 > 30) return null;
  const tolerance = Math.min(45, Math.max(18, Math.ceil(borderP95 + 24)));
  const toleranceSquared = tolerance * tolerance;
  const pixelCount = width * height;
  const removed = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  let queueStart = 0;
  let queueEnd = 0;
  const enqueue = (pixelIndex: number) => {
    if (removed[pixelIndex]) return;
    const offset = pixelIndex * channels;
    if (colorDistanceSquared(input, offset, background) > toleranceSquared) return;
    removed[pixelIndex] = 1;
    queue[queueEnd++] = pixelIndex;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (queueStart < queueEnd) {
    const pixelIndex = queue[queueStart++];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }
  if (queueEnd < Math.max(1, Math.floor(pixelCount * 0.02)) || queueEnd > Math.floor(pixelCount * 0.98)) return null;

  const data = Buffer.from(input);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const alphaOffset = pixelIndex * channels + channels - 1;
    if (removed[pixelIndex]) {
      data[alphaOffset] = 0;
      continue;
    }
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) return null;
  const subjectWidth = right - left + 1;
  const subjectHeight = bottom - top + 1;
  const padding = Math.max(1, Math.ceil(Math.max(subjectWidth, subjectHeight) * 0.04));
  left = Math.max(0, left - padding);
  top = Math.max(0, top - padding);
  right = Math.min(width - 1, right + padding);
  bottom = Math.min(height - 1, bottom + padding);
  return { data, crop: { left, top, width: right - left + 1, height: bottom - top + 1 } };
}

function rawImageHasTransparency(data: Buffer, channels: number) {
  const alphaOffset = channels - 1;
  for (let index = alphaOffset; index < data.length; index += channels) {
    if (data[index] < 255) return true;
  }
  return false;
}

function sampleImageBorder(data: Buffer, width: number, height: number, channels: number): number[][] {
  const perimeter = Math.max(1, 2 * width + 2 * Math.max(0, height - 2));
  const step = Math.max(1, Math.floor(perimeter / 4096));
  const pixels: number[][] = [];
  let visited = 0;
  const sample = (x: number, y: number) => {
    if (visited++ % step !== 0) return;
    const offset = (y * width + x) * channels;
    pixels.push([data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0]);
  };
  for (let x = 0; x < width; x += 1) sample(x, 0);
  for (let y = 1; y < height; y += 1) sample(width - 1, y);
  for (let x = width - 2; x >= 0; x -= 1) sample(x, height - 1);
  for (let y = height - 2; y > 0; y -= 1) sample(0, y);
  return pixels;
}

function median(values: number[]) {
  const sorted = values.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function colorDistance(pixel: number[], reference: number[]) {
  return Math.sqrt(
    ((pixel[0] ?? 0) - (reference[0] ?? 0)) ** 2 +
    ((pixel[1] ?? 0) - (reference[1] ?? 0)) ** 2 +
    ((pixel[2] ?? 0) - (reference[2] ?? 0)) ** 2
  );
}

function colorDistanceSquared(data: Buffer, offset: number, reference: number[]) {
  return (
    ((data[offset] ?? 0) - (reference[0] ?? 0)) ** 2 +
    ((data[offset + 1] ?? 0) - (reference[1] ?? 0)) ** 2 +
    ((data[offset + 2] ?? 0) - (reference[2] ?? 0)) ** 2
  );
}
