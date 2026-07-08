import type { ChatContentPart, ImageReference } from "../models/openrouter.js";
import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { AgentFile, DiscordAttachmentContext, ToolContext } from "./types.js";
import { extractDiscordMessageId, extractMentionId, visibleIndexedChannelIdsForRequest } from "./toolContext.js";

const DEFAULT_VISION_MODEL = "google/gemini-3.1-flash-lite";
const MAX_IMAGE_REFERENCES = 4;

export type GenerateImageInput = {
  prompt: string;
  referenceImageUrls?: string[];
  useContextImages?: boolean;
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
    resultSummary: summarizeForAudit({ imageCount: references.length })
  });

  if (references.length === 0) {
    return "I do not have any visible Discord image attachments or image URLs to inspect for that request.";
  }

  const response = await ctx.openRouter.chat({
    model: DEFAULT_VISION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You inspect Discord image attachments for a private server assistant. Answer the user's visual question using only the supplied images and labels. Be concise, direct, and mention uncertainty only when the image is unclear."
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
          ...references.map((reference): ChatContentPart => ({ type: "image_url", image_url: { url: reference.url } }))
        ]
      }
    ],
    temperature: 0.2,
    maxTokens: 4096
  });

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

export async function generateImage(
  ctx: ToolContext,
  input: string | GenerateImageInput
): Promise<{ content: string; files: AgentFile[] }> {
  const normalizedInput = typeof input === "string" ? { prompt: input } : input;
  const prompt = normalizedInput.prompt.trim();
  const references = await imageReferencesForInput(ctx, {
    explicitUrls: normalizedInput.referenceImageUrls,
    useContextImages: normalizedInput.useContextImages ?? true
  });
  const image = await ctx.openRouter.generateImage(prompt, {
    inputReferences: references.map((reference): ImageReference => ({ type: "image_url", image_url: { url: reference.url } }))
  });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "generateImage",
    argumentsSummary: summarizeForAudit({ prompt, referenceImageCount: references.length }),
    resultSummary: summarizeForAudit({ images: image.data.length, referenceImageCount: references.length }),
    model: image.model,
    estimatedCostUsd: image.estimatedCostUsd
  });

  const files: AgentFile[] = [];
  const urls: string[] = [];

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
      else urls.push(item.url);
    }
  }

  const promptSummary = truncateForDiscord(prompt, 240);
  const referenceSummary = references.length > 0 ? `\nUsed ${references.length} reference image${references.length === 1 ? "" : "s"}.` : "";
  const content =
    urls.length > 0
      ? `Generated image for: ${promptSummary}${referenceSummary}\n${urls.join("\n")}`
      : `Generated image for: ${promptSummary}${referenceSummary}`;
  return { content, files };
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
      references.push({
        url: attachment.url,
        label: `${attachment.filename ?? attachment.attachmentId} from ${attachment.link}`,
        contentType: attachment.contentType,
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
