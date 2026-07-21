import { isOpenRouterContentFilterError, isOpenRouterHttpError, type ChatContentPart, type ImageReference } from "../models/openrouter.js";
import { runObservedModelCall } from "../agent/modelCallTelemetry.js";
import sharp from "sharp";
import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import { normalizeGeneratedTransparentImage } from "./imageTransparency.js";
import type { AgentFile, DiscordAttachmentContext, ToolContext } from "./types.js";
import { extractDiscordMessageId, extractMentionId, visibleIndexedChannelIdsForRequest } from "./toolContext.js";

const DEFAULT_VISION_MODEL = "google/gemini-3.1-flash-lite";
const MAX_IMAGE_REFERENCES = 4;
const MAX_INLINE_VISION_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_VISION_TOTAL_BYTES = 20 * 1024 * 1024;
const VISION_IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

export type GenerateImageInput = {
  prompt: string;
  referenceImageUrls?: string[];
  useContextImages?: boolean;
  outputFormat?: "png" | "jpeg" | "webp";
  background?: "auto" | "transparent" | "opaque";
};

export type InspectDiscordImagesInput = {
  question?: string;
  imageUrls?: string[];
  messageIdOrUrl?: string;
  useContextImages?: boolean;
};

export type GetDiscordUserAvatarInput = {
  query: string;
  limit?: number;
};

export async function getDiscordUserAvatar(ctx: ToolContext, input: GetDiscordUserAvatarInput): Promise<string> {
  const query = input.query.trim();
  if (!query) return "Provide a Discord username, mention, or user ID to look up the avatar.";

  const limit = Math.max(1, Math.min(5, Math.floor(input.limit ?? 1)));
  const resolvedUserIds = await resolveDiscordUserIdsForAvatar(ctx, query, limit);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "getDiscordUserAvatar",
    argumentsSummary: summarizeForAudit({ query, limit, resolvedUserIds: resolvedUserIds.length }),
    resultSummary: summarizeForAudit({ resolvedUserIds: resolvedUserIds.length })
  });

  if (resolvedUserIds.length === 0) {
    return "I could not resolve a visible Discord user matching that query. Try a username, @mention, or user ID.";
  }

  if (!ctx.fetchDiscordUserAvatar) {
    return [
      "I resolved the user but cannot fetch a live avatar URL in this execution context.",
      `Resolved user ID(s): ${resolvedUserIds.join(", ")}`,
      "Avatar fetching requires the Discord client, which is not attached to this run."
    ].join("\n");
  }

  const rows: string[] = [];
  for (const [index, userId] of resolvedUserIds.entries()) {
    const avatar = await ctx.fetchDiscordUserAvatar({ guildId: ctx.guildId, userId }).catch(() => null);
    if (!avatar) {
      rows.push(`[${index + 1}] id=${userId} avatar=unavailable (user not found via Discord)`);
      continue;
    }
    const name = [avatar.globalName, avatar.username ? `@${avatar.username}` : null].filter(Boolean).join(" / ") || "(unknown user)";
    const botTag = avatar.isBot ? " bot=true" : "";
    const customTag = avatar.hasCustomAvatar ? "" : " default_avatar=true";
    const globalLine = avatar.globalAvatarUrl && avatar.globalAvatarUrl !== avatar.avatarUrl ? `\nGlobal avatar: ${avatar.globalAvatarUrl}` : "";
    rows.push(`[${index + 1}] ${name} id=${userId}${botTag}${customTag}\nAvatar: ${avatar.avatarUrl}${globalLine}`);
  }

  return [
    "Discord avatar(s):",
    ...rows,
    "",
    "Pass the avatar URL above to inspectDiscordImages (imageUrls) to describe, enhance, or zoom into the profile picture."
  ].join("\n");
}

async function resolveDiscordUserIdsForAvatar(ctx: ToolContext, query: string, limit: number): Promise<string[]> {
  const mentionId = extractMentionId(query, "user");
  if (mentionId) return [mentionId];
  if (/^\d{17,20}$/.test(query)) return [query];

  const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
  const matches = await ctx.repo.findDiscordUsers({
    guildId: ctx.guildId,
    visibleChannelIds: visibleIndexedChannels,
    query,
    limit
  });
  return matches.map((match) => match.id);
}

export async function inspectDiscordImages(ctx: ToolContext, input: InspectDiscordImagesInput = {}): Promise<string> {
  const question = input.question?.trim() || "Describe the relevant visual details in these Discord image attachments.";
  const references = await imageReferencesForInput(ctx, {
    explicitUrls: input.imageUrls,
    messageIdOrUrl: input.messageIdOrUrl,
    useContextImages: input.useContextImages ?? true
  });
  const prepared = await inlineDiscordCdnImageReferences(ctx, references);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "inspectDiscordImages",
    argumentsSummary: summarizeForAudit({
      question,
      explicitImageUrls: input.imageUrls?.length ?? 0,
      messageIdOrUrl: input.messageIdOrUrl,
      useContextImages: input.useContextImages ?? true
    }),
    resultSummary: summarizeForAudit({
      imageCount: references.length,
      inlinedDiscordImages: prepared.inlined,
      discordImageInlineFailures: prepared.failed
    })
  });

  if (references.length === 0) {
    return "I do not have any visible Discord image attachments or image URLs to inspect for that request.";
  }

  const response = await runObservedModelCall(ctx, { purpose: "discord_image_inspection", chat: {
    model: DEFAULT_VISION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You inspect Discord image attachments for a Discord server assistant. Answer the user's visual question using only the supplied images and labels. Be concise, direct, and mention uncertainty only when the image is unclear."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Question: ${question}\n` +
              `Images supplied: ${references.length}\n` +
              references.map((reference, index) => `${index + 1}. ${reference.label}`).join("\n")
          },
          ...prepared.references.map((reference): ChatContentPart => ({
            type: "image_url",
            image_url: { url: reference.url }
          }))
        ]
      }
    ],
    temperature: 0.2,
    maxTokens: 4096
  } });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "inspectDiscordImagesResult",
    argumentsSummary: summarizeForAudit({ question, imageCount: references.length }),
    resultSummary: summarizeForAudit(response.content),
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd
  });

  const labels = references.map((reference, index) => `[${index + 1}] ${reference.label}`).join("\n");
  return [`Vision result (${references.length} image${references.length === 1 ? "" : "s"}):`, response.content.trim(), "", "Images:", labels]
    .filter(Boolean)
    .join("\n");
}

async function inlineDiscordCdnImageReferences(
  ctx: ToolContext,
  references: ImageReferenceContext[]
): Promise<{ references: ImageReferenceContext[]; inlined: number; failed: number }> {
  let remainingBytes = MAX_INLINE_VISION_TOTAL_BYTES;
  let inlined = 0;
  let failed = 0;
  const prepared: ImageReferenceContext[] = [];
  for (const reference of references) {
    if (!isDiscordCdnUrl(reference.url) || remainingBytes <= 0) {
      prepared.push(reference);
      continue;
    }
    try {
      const result = await fetchDiscordImageDataUri(
        reference.url,
        Math.min(MAX_INLINE_VISION_IMAGE_BYTES, remainingBytes),
        ctx.abortSignal
      );
      prepared.push({ ...reference, url: result.dataUri, contentType: result.contentType });
      remainingBytes -= result.bytes;
      inlined += 1;
    } catch (error) {
      if (ctx.abortSignal?.aborted) throw error;
      prepared.push(reference);
      failed += 1;
    }
  }
  return { references: prepared, inlined, failed };
}

function isDiscordCdnUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (hostname === "cdn.discordapp.com" || hostname === "media.discordapp.net");
  } catch {
    return false;
  }
}

async function fetchDiscordImageDataUri(url: string, maxBytes: number, abortSignal?: AbortSignal) {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(abortSignal?.reason);
  abortSignal?.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(), VISION_IMAGE_DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();
  try {
    let response = await fetch(url, { signal: controller.signal, redirect: "error" });
    const fallbackUrl = discordEmojiPngFallbackUrl(url);
    if (response.status === 415 && fallbackUrl) {
      await response.body?.cancel();
      response = await fetch(fallbackUrl, { signal: controller.signal, redirect: "error" });
    }
    if (!response.ok) throw new Error(`Discord CDN returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) throw new Error("Discord CDN response was not an image");
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error(`Discord image exceeds the ${maxBytes}-byte vision limit`);
    }
    if (!response.body) throw new Error("Discord CDN response had no body");
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        controller.abort();
        throw new Error(`Discord image exceeds the ${maxBytes}-byte vision limit`);
      }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks, total);
    return { dataUri: `data:${contentType};base64,${data.toString("base64")}`, contentType, bytes: total };
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abortFromRequest);
  }
}

function discordEmojiPngFallbackUrl(value: string) {
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "cdn.discordapp.com" || !/^\/emojis\/[^/]+\.gif$/i.test(url.pathname)) {
    return undefined;
  }
  url.pathname = url.pathname.replace(/\.gif$/i, ".png");
  return url.toString();
}

export async function generateImage(
  ctx: ToolContext,
  input: string | GenerateImageInput
): Promise<{ content: string; files: AgentFile[]; status?: "ok" | "error" }> {
  const normalizedInput = typeof input === "string" ? { prompt: input } : input;
  const prompt = normalizedInput.prompt.trim();
  const references = await imageReferencesForInput(ctx, {
    explicitUrls: normalizedInput.referenceImageUrls,
    useContextImages: normalizedInput.useContextImages ?? true
  });
  const inferredTransparentBackground = normalizedInput.background == null && wantsTransparentImage(prompt);
  const background = normalizedInput.background ?? (inferredTransparentBackground ? "transparent" : undefined);
  const outputFormat = normalizedInput.outputFormat ?? (background === "transparent" ? "png" : undefined);
  let image;
  try {
    image = await ctx.openRouter.generateImage(prompt, {
      inputReferences: references.map((reference): ImageReference => ({ type: "image_url", image_url: { url: reference.url } })),
      ...(outputFormat ? { outputFormat } : {}),
      ...(background ? { background } : {}),
    });
  } catch (error) {
    const contentFilterBlocked = isOpenRouterContentFilterError(error);
    const requestRejected = isOpenRouterHttpError(error) && error.status === 400;
    if (!contentFilterBlocked && !requestRejected) throw error;
    const errorCode = contentFilterBlocked ? "image_generation_blocked" : "image_generation_request_rejected";
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "generateImage",
      argumentsSummary: summarizeForAudit({ prompt, referenceImageCount: references.length, outputFormat, background }),
      resultSummary: errorCode,
      error: errorCode,
    });
    return {
      content: contentFilterBlocked
        ? "Image generation was blocked by the provider's safety filter, so no image was created. Explain that briefly and conversationally, then offer a safe adjustment to the request. Do not expose provider errors or claim that an image was attached."
        : "The image provider could not accept that image request, so no image was created. Explain that briefly and conversationally, then offer to retry with a simpler request. Do not expose provider errors or claim that an image was attached.",
      files: [],
      status: "error",
    };
  }

  let files: AgentFile[] = [];
  const urls: string[] = [];
  let rejectedOpaqueImages = 0;

  for (const [index, item] of image.data.entries()) {
    if (item.b64_json) {
      const contentType = item.media_type ?? item.content_type ?? "image/png";
      files.push({
        name: `discord-ai-agent-${Date.now()}-${index + 1}.${extensionForContentType(contentType)}`,
        data: Buffer.from(item.b64_json, "base64"),
        contentType
      });
    } else if (item.url) {
      const file = await imageUrlToAgentFile(item.url, index).catch(() => undefined);
      if (file) files.push(file);
      else if (background === "transparent") rejectedOpaqueImages += 1;
      else urls.push(item.url);
    }
  }

  let automaticBackgroundRemovalCount = 0;
  if (background === "transparent") {
    const normalized = await Promise.all(files.map(normalizeGeneratedTransparentImage));
    files = normalized.flatMap((result) => {
      if (!result.file) {
        rejectedOpaqueImages += 1;
        return [];
      }
      if (result.backgroundRemoved) automaticBackgroundRemovalCount += 1;
      return [result.file];
    });
  }

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "generateImage",
    argumentsSummary: summarizeForAudit({ prompt, referenceImageCount: references.length, outputFormat, background }),
    resultSummary: summarizeForAudit({
      images: image.data.length,
      attachedImages: files.length,
      referenceImageCount: references.length,
      outputFormat,
      background,
      automaticBackgroundRemovalCount,
      rejectedOpaqueImages
    }),
    model: image.model,
    estimatedCostUsd: image.estimatedCostUsd
  });

  const promptSummary = truncateForDiscord(prompt, 240);
  const referenceSummary = references.length > 0 ? `\nUsed ${references.length} reference image${references.length === 1 ? "" : "s"}.` : "";
  const requestedOutputSummary = background || outputFormat
    ? `\nRequested output: ${[background ? `${background} background` : null, outputFormat?.toUpperCase()].filter(Boolean).join(", ")}.`
    : "";
  const actualOutputSummary = requestedOutputSummary && files.length > 0
    ? `\nActual output: ${(await Promise.all(files.map(describeGeneratedImageFile))).join(", ")}.`
    : "";
  const backgroundRemovalSummary = automaticBackgroundRemovalCount > 0
    ? `\nAutomatic background removal: applied to ${automaticBackgroundRemovalCount} image${automaticBackgroundRemovalCount === 1 ? "" : "s"}.`
    : "";
  const transparencyFailureSummary = rejectedOpaqueImages > 0
    ? `\nTransparency validation failed for ${rejectedOpaqueImages} generated image${rejectedOpaqueImages === 1 ? "" : "s"}: the provider returned opaque output and automatic background removal could not safely isolate a foreground subject. No opaque image was attached.`
    : "";
  const content =
    urls.length > 0
      ? `Generated image for: ${promptSummary}${referenceSummary}${requestedOutputSummary}${actualOutputSummary}${backgroundRemovalSummary}${transparencyFailureSummary}\n${urls.join("\n")}`
      : `Generated image for: ${promptSummary}${referenceSummary}${requestedOutputSummary}${actualOutputSummary}${backgroundRemovalSummary}${transparencyFailureSummary}`;
  return { content, files };
}

const TRANSPARENT_IMAGE_INTENT = /\b(?:transparent(?:\s+background)?|no\s+background|remove\s+(?:the\s+)?background|background[- ]?free|cutout|emoji|sticker)\b/i;

function wantsTransparentImage(prompt: string) {
  return TRANSPARENT_IMAGE_INTENT.test(prompt);
}

async function describeGeneratedImageFile(file: AgentFile) {
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

export type ImageReferenceContext = {
  url: string;
  label: string;
  contentType?: string | null;
  source: "current_request" | "reply_context" | "message_attachment" | "explicit_url";
};

export async function imageReferencesForInput(
  ctx: ToolContext,
  input: { explicitUrls?: string[]; messageIdOrUrl?: string; useContextImages?: boolean }
): Promise<ImageReferenceContext[]> {
  const references: ImageReferenceContext[] = [];
  for (const url of normalizeImageUrls(input.explicitUrls)) {
    references.push({ url, label: `Explicit image URL: ${url}`, source: "explicit_url" });
  }

  const messageId = input.messageIdOrUrl ? extractDiscordMessageId(input.messageIdOrUrl) : undefined;
  if (messageId) {
    const visibleIndexedChannels = await visibleIndexedChannelIdsForRequest(ctx);
    const attachments = await ctx.repo.messageAttachments({
      guildId: ctx.guildId,
      visibleChannelIds: visibleIndexedChannels,
      messageId,
      limit: MAX_IMAGE_REFERENCES
    });
    for (const attachment of attachments) {
      if (!isImageAttachmentLike(attachment)) continue;
      const fresh = ctx.fetchDiscordAttachment
        ? await ctx.fetchDiscordAttachment({
            channelId: attachment.channelId,
            messageId: attachment.messageId,
            attachmentId: attachment.attachmentId
          }).catch(() => null)
        : null;
      references.push({
        url: fresh?.url ?? attachment.url,
        label: `${attachment.filename ?? attachment.attachmentId} from ${attachment.link}`,
        contentType: fresh?.contentType ?? attachment.contentType,
        source: "message_attachment"
      });
    }
  }

  if (input.useContextImages) {
    references.push(...contextImageReferences(ctx));
  }

  return dedupeImageReferences(references).slice(0, MAX_IMAGE_REFERENCES);
}

function contextImageReferences(ctx: ToolContext): ImageReferenceContext[] {
  const references: ImageReferenceContext[] = [];
  for (const attachment of ctx.requestAttachments ?? []) {
    const reference = discordAttachmentContextToReference(attachment, "current_request", "current request");
    if (reference) references.push(reference);
  }

  for (const message of ctx.replyContext?.chain ?? []) {
    for (const attachment of message.attachments ?? []) {
      const labelPrefix = message.url ? `reply context message ${message.url}` : `reply context message ${message.messageId}`;
      const reference = discordAttachmentContextToReference(attachment, "reply_context", labelPrefix);
      if (reference) references.push(reference);
    }
  }
  return references;
}

function discordAttachmentContextToReference(
  attachment: DiscordAttachmentContext,
  source: ImageReferenceContext["source"],
  labelPrefix: string
): ImageReferenceContext | undefined {
  if (!isImageAttachmentLike(attachment) || !isSupportedImageReferenceUrl(attachment.url)) return undefined;
  const bits = [
    attachment.filename ?? attachment.id,
    attachment.contentType,
    attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : undefined,
    attachment.description ? `description=${attachment.description}` : undefined
  ].filter(Boolean);
  return {
    url: attachment.url,
    label: `${labelPrefix}: ${bits.join(" | ") || attachment.url}`,
    contentType: attachment.contentType,
    source
  };
}

function normalizeImageUrls(urls: string[] | undefined): string[] {
  return [...new Set((urls ?? []).map((url) => url.trim()).filter(isSupportedImageReferenceUrl))];
}

function dedupeImageReferences(references: ImageReferenceContext[]) {
  const seen = new Set<string>();
  const deduped: ImageReferenceContext[] = [];
  for (const reference of references) {
    const key = reference.url;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reference);
  }
  return deduped;
}

function isImageAttachmentLike(attachment: Pick<DiscordAttachmentContext, "url" | "filename" | "contentType">) {
  return (
    isSupportedImageReferenceUrl(attachment.url) &&
    (attachment.contentType?.toLowerCase().startsWith("image/") ||
      /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(attachment.filename ?? attachment.url))
  );
}

function isSupportedImageReferenceUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
}

function extensionForContentType(contentType: string) {
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "png";
}

async function imageUrlToAgentFile(url: string, index: number): Promise<AgentFile> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "image/png";
  if (!contentType.startsWith("image/")) throw new Error(`Image URL returned ${contentType}`);
  return {
    name: `discord-ai-agent-${Date.now()}-${index + 1}.${extensionForContentType(contentType)}`,
    data: Buffer.from(await response.arrayBuffer()),
    contentType
  };
}
