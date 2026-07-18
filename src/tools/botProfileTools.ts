import { summarizeForAudit } from "../util/text.js";
import type { AgentFile, ToolContext } from "./types.js";
import { imageReferencesForInput } from "./imageTools.js";
import { updateDiscordBotAvatar } from "../discord/api.js";

export type UpdateBotAvatarInput = {
  imageUrl?: string;
  messageIdOrUrl?: string;
  useContextImage?: boolean;
};

const MAX_AVATAR_BYTES = 8_000_000;
const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DATA_URI_CONTENT_TYPES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif"
};

export type UpdateBotAvatarResult = {
  ok: boolean;
  message: string;
};

export async function updateBotAvatar(ctx: ToolContext, input: UpdateBotAvatarInput = {}): Promise<string> {
  const token = ctx.config.discord.token;
  if (!token) {
    await auditAvatar(ctx, input, "missing discord token", true);
    return "I cannot update my avatar because no Discord bot token is configured.";
  }

  const source = await resolveAvatarSource(ctx, input).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error" as const, message };
  });

  if (source.kind === "error") {
    await auditAvatar(ctx, input, `image resolve failed: ${source.message}`, true);
    return `I could not get an image for the avatar update: ${source.message}`;
  }
  if (source.kind === "none") {
    await auditAvatar(ctx, input, "no image source", true);
    return "I need an image URL or a context image to update my avatar. Provide an imageUrl or attach/reply to an image.";
  }

  let dataUri: string;
  try {
    dataUri = await toAvatarDataUri(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditAvatar(ctx, input, `image encode failed: ${message}`, true, { sourceLabel: source.label });
    return `I could not prepare that image for Discord: ${message}`;
  }

  let response: Response;
  let profile: { avatar?: string | null; id?: string; username?: string } | undefined;
  try {
    ({ response, profile } = await updateDiscordBotAvatar(token, dataUri));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditAvatar(ctx, input, `discord api network error: ${message}`, true, { sourceLabel: source.label });
    return `I could not reach Discord's API to update my avatar: ${message}`;
  }

  if (response.status === 429) {
    const retryAfter = await parseRetryAfter(response);
    await auditAvatar(ctx, input, `discord rate limited (retry after ${retryAfter}ms)`, true, { sourceLabel: source.label });
    return `Discord is rate-limiting avatar updates. Try again in about ${Math.max(1, Math.round(retryAfter / 1000))} second(s).`;
  }
  if (!response.ok) {
    const body = await safeErrorBody(response);
    await auditAvatar(ctx, input, `discord api ${response.status}: ${body}`, true, { sourceLabel: source.label });
    return `Discord rejected the avatar update (HTTP ${response.status}). ${body}`.trim();
  }

  let newAvatarUrl: string | undefined;
  try {
    newAvatarUrl = profile?.id && profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : undefined;
  } catch {
    // Non-fatal: the PATCH succeeded even if we could not parse the body.
  }

  await auditAvatar(ctx, input, "avatar updated", false, { sourceLabel: source.label, newAvatarUrl });

  return [
    "Updated my Discord bot avatar.",
    newAvatarUrl ? `New avatar: ${newAvatarUrl}` : "",
    `Source: ${source.label}`
  ]
    .filter(Boolean)
    .join("\n");
}

type AvatarSource =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "buffer"; buffer: Buffer; contentType: string; label: string }
  | { kind: "url"; url: string; label: string };

async function resolveAvatarSource(ctx: ToolContext, input: UpdateBotAvatarInput): Promise<AvatarSource> {
  const explicitUrl = input.imageUrl?.trim();
  if (explicitUrl) {
    if (!/^https?:\/\//i.test(explicitUrl) && !/^data:image\//i.test(explicitUrl)) {
      return { kind: "error", message: `imageUrl must be an http(s) or data: image URL` };
    }
    return { kind: "url", url: explicitUrl, label: `explicit URL: ${explicitUrl}` };
  }

  const generatedImage = pickGeneratedImage(ctx.turnOutput?.files);
  if (generatedImage) {
    return {
      kind: "buffer",
      buffer: generatedImage.data,
      contentType: generatedImage.contentType ?? "image/png",
      label: `generated image: ${generatedImage.name}`
    };
  }

  const useContextImage = input.useContextImage ?? true;
  const references = await imageReferencesForInput(ctx, {
    messageIdOrUrl: input.messageIdOrUrl,
    useContextImages: useContextImage
  });
  if (references.length === 0) {
    return { kind: "none" };
  }
  const reference = references[0];
  return { kind: "url", url: reference.url, label: reference.label };
}

function pickGeneratedImage(files: AgentFile[] | undefined): { name: string; data: Buffer; contentType?: string } | undefined {
  for (const file of files ?? []) {
    const contentType = (file.contentType ?? "").toLowerCase();
    const isImage = contentType.startsWith("image/") || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name);
    if (isImage && file.data && file.data.length > 0) {
      return file;
    }
  }
  return undefined;
}

async function toAvatarDataUri(source: Exclude<AvatarSource, { kind: "none" } | { kind: "error" }>): Promise<string> {
  if (source.kind === "buffer") {
    const contentType = normalizeContentType(source.contentType);
    assertAllowedContentType(contentType);
    assertSize(source.buffer.length);
    return `data:${contentType};base64,${source.buffer.toString("base64")}`;
  }

  if (source.url.startsWith("data:")) {
    return dataUriFromDataUrl(source.url);
  }

  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) {
    return Promise.reject(new Error(`image fetch failed (HTTP ${response.status})`));
  }
  const contentType = normalizeContentType(response.headers.get("content-type") ?? "");
  if (!contentType || !contentType.startsWith("image/")) {
    return Promise.reject(new Error(`image URL did not return an image content-type (got ${contentType || "none"})`));
  }
  assertAllowedContentType(contentType);
  const buffer = Buffer.from(await response.arrayBuffer());
  assertSize(buffer.length);
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function dataUriFromDataUrl(value: string): string {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(value);
  if (!match) {
    throw new Error("data: URL was not a valid base64 image data URI");
  }
  const contentType = normalizeContentType(match[1]);
  assertAllowedContentType(contentType);
  const isBase64 = Boolean(match[2]);
  if (isBase64) {
    const buffer = Buffer.from(match[3], "base64");
    assertSize(buffer.length);
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  }
  const buffer = Buffer.from(decodeURIComponent(match[3]));
  assertSize(buffer.length);
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function normalizeContentType(value: string): string {
  const trimmed = value.split(";")[0].trim().toLowerCase();
  return DATA_URI_CONTENT_TYPES[trimmed] ?? trimmed;
}

function assertAllowedContentType(contentType: string): void {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Discord accepts PNG, JPEG, WebP, or GIF avatars (got ${contentType || "unknown"})`);
  }
}

function assertSize(bytes: number): void {
  if (bytes > MAX_AVATAR_BYTES) {
    throw new Error(`image is too large for a Discord avatar (${Math.round(bytes / 1000)}KB > ${Math.round(MAX_AVATAR_BYTES / 1000)}KB)`);
  }
}

async function parseRetryAfter(response: Response): Promise<number> {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  try {
    const json = (await response.json()) as { retry_after?: number };
    if (typeof json.retry_after === "number" && Number.isFinite(json.retry_after)) {
      return Math.max(0, json.retry_after * 1000);
    }
  } catch {
    // ignore
  }
  return 5000;
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ? text.slice(0, 500) : "";
  } catch {
    return "";
  }
}

function decodeURIComponent(value: string): string {
  try {
    return globalThis.decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function auditAvatar(
  ctx: ToolContext,
  input: UpdateBotAvatarInput,
  resultSummary: string,
  isError = false,
  extra?: Record<string, unknown>
): Promise<void> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "updateBotAvatar",
    argumentsSummary: summarizeForAudit({
      imageUrl: input.imageUrl,
      messageIdOrUrl: input.messageIdOrUrl,
      useContextImage: input.useContextImage ?? true
    }),
    resultSummary: summarizeForAudit(extra ? { result: resultSummary, ...extra } : resultSummary),
    ...(isError ? { error: resultSummary } : {})
  });
}
