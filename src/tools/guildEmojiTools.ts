import sharp from "sharp";
import { summarizeForAudit } from "../util/text.js";
import { imageReferencesForInput } from "./imageTools.js";
import type { ToolContext } from "./types.js";

export type CreateDiscordEmojiInput = {
  name?: string;
  imageUrl?: string;
  messageIdOrUrl?: string;
  useContextImage?: boolean;
  requireTransparent?: boolean;
};

const MAX_SOURCE_BYTES = 8_000_000;
const MAX_EMOJI_BYTES = 256 * 1024;
const EMOJI_SIZE = 128;
const MAX_ANIMATION_FRAMES = 60;
const ALLOWED_SOURCE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export async function createDiscordEmoji(ctx: ToolContext, input: CreateDiscordEmojiInput): Promise<string> {
  const requestedName = input.name?.trim() ?? "";
  const name = normalizeEmojiName(requestedName);
  if (!name) {
    await auditEmoji(ctx, input, "invalid or missing emoji name", true);
    return "I need an emoji name with 2–32 letters, numbers, or underscores.";
  }
  if (!ctx.createDiscordEmoji) {
    await auditEmoji(ctx, input, "guild emoji creation is not wired in this runtime", true);
    return "I cannot upload a server emoji from this runtime. Try asking me in a normal Discord server channel.";
  }

  let source: EmojiSource | null;
  try {
    source = await resolveEmojiSource(ctx, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditEmoji(ctx, input, `image resolve failed: ${message}`, true);
    return `I could not get an image for the Discord emoji: ${message}`;
  }
  if (!source) {
    await auditEmoji(ctx, input, "no image source", true);
    return "I need an image URL or a generated, attached, or replied-to image to create the emoji.";
  }

  let prepared: PreparedEmoji;
  try {
    prepared = await prepareEmoji(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditEmoji(ctx, input, `image preparation failed: ${message}`, true, { source: source.label });
    return `I could not prepare that image as a Discord emoji: ${message}`;
  }
  const requireTransparent = input.requireTransparent ?? source.label.startsWith("generated image ");
  if (requireTransparent && prepared.sourceTransparency !== "transparent") {
    const result = prepared.sourceTransparency === "opaque"
      ? "source image is opaque; no emoji was uploaded"
      : "source transparency could not be verified; no emoji was uploaded";
    await auditEmoji(ctx, input, result, true, { source: source.label, sourceTransparency: prepared.sourceTransparency });
    return [
      "I did not upload that emoji because the source does not contain verified alpha transparency.",
      "A checkerboard drawn into a JPEG/PNG is still an opaque background.",
      "Regenerate or provide a PNG/WebP with real transparency, then retry. Set requireTransparent=false only when an opaque rectangular emoji is intentional.",
    ].join("\n");
  }

  try {
    const created = await ctx.createDiscordEmoji({
      name,
      image: prepared.buffer,
      auditLogReason: `AI emoji upload requested by ${ctx.userDisplayName} (${ctx.userId})`,
    });
    await auditEmoji(ctx, input, `created emoji ${created.id}`, false, {
      emojiId: created.id,
      emojiName: created.name,
      source: source.label,
      bytes: prepared.buffer.length,
      animationPreserved: prepared.animationPreserved,
      sourceTransparency: prepared.sourceTransparency,
    });
    return [
      `Uploaded server emoji ${created.mention} as :${created.name}:.`,
      `Source: ${source.label}`,
      `Prepared: ${EMOJI_SIZE}×${EMOJI_SIZE} WebP · ${Math.ceil(prepared.buffer.length / 1024)} KiB`,
      `Transparency: ${prepared.sourceTransparency === "transparent" ? "real source alpha preserved" : "opaque source retained by request"}`,
      prepared.animationFlattened ? "The source animation was flattened to its first frame to fit Discord's upload limit." : null,
    ].filter((line): line is string => Boolean(line)).join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditEmoji(ctx, input, `Discord emoji upload failed: ${message}`, true, { source: source.label });
    return `I could not upload the server emoji: ${message}`;
  }
}

type EmojiSource =
  | { kind: "buffer"; buffer: Buffer; contentType: string; label: string }
  | { kind: "url"; url: string; label: string };

type PreparedEmoji = {
  buffer: Buffer;
  animationPreserved: boolean;
  animationFlattened: boolean;
  sourceTransparency: "transparent" | "opaque" | "unknown";
};

async function resolveEmojiSource(ctx: ToolContext, input: CreateDiscordEmojiInput): Promise<EmojiSource | null> {
  const explicitUrl = input.imageUrl?.trim();
  if (explicitUrl) {
    if (!/^https?:\/\//i.test(explicitUrl) && !/^data:image\//i.test(explicitUrl)) {
      throw new Error("imageUrl must be an http(s) or data: image URL");
    }
    return { kind: "url", url: explicitUrl, label: "explicit image URL" };
  }

  const generated = [...(ctx.generatedFiles ?? [])].reverse().find((file) =>
    file.data.length > 0 && ((file.contentType ?? "").startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(file.name))
  );
  if (generated) {
    return {
      kind: "buffer",
      buffer: generated.data,
      contentType: generated.contentType ?? contentTypeFromName(generated.name),
      label: `generated image ${generated.name}`,
    };
  }

  if (input.useContextImage === false) return null;
  const references = await imageReferencesForInput(ctx, {
    messageIdOrUrl: input.messageIdOrUrl,
    useContextImages: true,
  });
  const reference = references[0];
  return reference ? { kind: "url", url: reference.url, label: reference.label } : null;
}

async function prepareEmoji(source: EmojiSource): Promise<PreparedEmoji> {
  const { buffer, contentType } = source.kind === "buffer"
    ? { buffer: source.buffer, contentType: normalizeContentType(source.contentType) }
    : await fetchImage(source.url);
  if (buffer.length > MAX_SOURCE_BYTES) throw new Error(`source image exceeds ${MAX_SOURCE_BYTES / 1_000_000} MB`);
  if (!ALLOWED_SOURCE_TYPES.has(contentType)) {
    throw new Error(`supported formats are PNG, JPEG, GIF, WebP, and AVIF (got ${contentType || "unknown"})`);
  }

  const metadata = await sharp(buffer, { animated: true, limitInputPixels: 40_000_000 }).metadata();
  const sourceTransparency = await imageTransparency(buffer);
  const frames = metadata.pages ?? 1;
  const preserveAnimation = frames > 1 && frames <= MAX_ANIMATION_FRAMES;
  const animated = preserveAnimation ? await encodeEmoji(buffer, true) : null;
  if (animated && animated.length <= MAX_EMOJI_BYTES) {
    return { buffer: animated, animationPreserved: true, animationFlattened: false, sourceTransparency };
  }
  const still = await encodeEmoji(buffer, false);
  if (still.length > MAX_EMOJI_BYTES) throw new Error("normalized image still exceeds Discord's 256 KiB emoji limit");
  return {
    buffer: still,
    animationPreserved: false,
    animationFlattened: frames > 1,
    sourceTransparency,
  };
}

async function imageTransparency(buffer: Buffer): Promise<PreparedEmoji["sourceTransparency"]> {
  try {
    const { data, info } = await sharp(buffer, { pages: 1, limitInputPixels: 40_000_000 })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaOffset = info.channels - 1;
    for (let index = alphaOffset; index < data.length; index += info.channels) {
      if (data[index] < 255) return "transparent";
    }
    return "opaque";
  } catch {
    return "unknown";
  }
}

async function encodeEmoji(buffer: Buffer, animated: boolean): Promise<Buffer> {
  for (const quality of [90, 75, 60, 45]) {
    const output = await sharp(buffer, {
      animated,
      pages: animated ? -1 : 1,
      limitInputPixels: 40_000_000,
    })
      .resize(EMOJI_SIZE, EMOJI_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality, alphaQuality: quality, effort: 4 })
      .toBuffer();
    if (output.length <= MAX_EMOJI_BYTES || quality === 45) return output;
  }
  throw new Error("could not encode image");
}

async function fetchImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (url.startsWith("data:")) return decodeDataImage(url);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`image fetch failed (HTTP ${response.status})`);
  const contentType = normalizeContentType(response.headers.get("content-type") ?? "");
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SOURCE_BYTES) {
    throw new Error(`source image exceeds ${MAX_SOURCE_BYTES / 1_000_000} MB`);
  }
  const buffer = await readBoundedBody(response, MAX_SOURCE_BYTES);
  return { buffer, contentType };
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`source image exceeds ${maxBytes / 1_000_000} MB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function decodeDataImage(value: string) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(value);
  if (!match) throw new Error("invalid data: image URL");
  const contentType = normalizeContentType(match[1]);
  const buffer = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(safeDecodeURIComponent(match[3]));
  return { buffer, contentType };
}

function normalizeEmojiName(value: string) {
  const normalized = value.replace(/^:+|:+$/g, "").trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return normalized.length >= 2 ? normalized : null;
}

function normalizeContentType(value: string) {
  const type = value.split(";")[0].trim().toLowerCase();
  return type === "image/jpg" ? "image/jpeg" : type;
}

function contentTypeFromName(name: string) {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.gif$/i.test(name)) return "image/gif";
  if (/\.avif$/i.test(name)) return "image/avif";
  return "image/webp";
}

function safeDecodeURIComponent(value: string) {
  try { return globalThis.decodeURIComponent(value); } catch { return value; }
}

async function auditEmoji(
  ctx: ToolContext,
  input: CreateDiscordEmojiInput,
  resultSummary: string,
  isError: boolean,
  extra?: Record<string, unknown>,
) {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "createDiscordEmoji",
    argumentsSummary: summarizeForAudit({
      name: input.name,
      imageUrl: input.imageUrl,
      messageIdOrUrl: input.messageIdOrUrl,
      useContextImage: input.useContextImage ?? true,
      requireTransparent: input.requireTransparent,
    }),
    resultSummary: summarizeForAudit(extra ? { result: resultSummary, ...extra } : resultSummary),
    ...(isError ? { error: resultSummary } : {}),
  });
}
