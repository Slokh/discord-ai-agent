import type { DiscordAttachmentContext, ToolContext } from "./types.js";
import { extractDiscordMessageId, visibleIndexedChannelIdsForRequest } from "./toolContext.js";

const MAX_IMAGE_REFERENCES = 4;

export type ImageReferenceContext = {
  url: string;
  label: string;
  contentType?: string | null;
  source: "current_request" | "reply_context" | "message_attachment" | "explicit_url";
};

export async function imageReferencesForInput(
  ctx: ToolContext,
  input: { explicitUrls?: string[]; messageIdOrUrl?: string; useContextImages?: boolean },
): Promise<ImageReferenceContext[]> {
  const references: ImageReferenceContext[] = normalizeImageUrls(input.explicitUrls)
    .map((url) => ({ url, label: `Explicit image URL: ${url}`, source: "explicit_url" }));
  const messageId = input.messageIdOrUrl ? extractDiscordMessageId(input.messageIdOrUrl) : undefined;
  if (messageId) {
    const attachments = await ctx.repo.messageAttachments({
      guildId: ctx.guildId,
      visibleChannelIds: await visibleIndexedChannelIdsForRequest(ctx),
      messageId,
      limit: MAX_IMAGE_REFERENCES,
    });
    for (const attachment of attachments) {
      if (!isImageAttachmentLike(attachment)) continue;
      const fresh = ctx.fetchDiscordAttachment
        ? await ctx.fetchDiscordAttachment({ channelId: attachment.channelId, messageId: attachment.messageId, attachmentId: attachment.attachmentId }).catch(() => null)
        : null;
      references.push({
        url: fresh?.url ?? attachment.url,
        label: `${attachment.filename ?? attachment.attachmentId} from ${attachment.link}`,
        contentType: fresh?.contentType ?? attachment.contentType,
        source: "message_attachment",
      });
    }
  }
  if (input.useContextImages) references.push(...contextImageReferences(ctx));
  return dedupeImageReferences(references).slice(0, MAX_IMAGE_REFERENCES);
}

function contextImageReferences(ctx: Pick<ToolContext, "requestAttachments" | "replyContext">): ImageReferenceContext[] {
  const references: ImageReferenceContext[] = [];
  for (const attachment of ctx.requestAttachments ?? []) {
    const reference = discordAttachmentContextToReference(attachment, "current_request", "current request");
    if (reference) references.push(reference);
  }
  for (const message of [...(ctx.replyContext?.chain ?? [])].reverse()) {
    for (const attachment of message.attachments ?? []) {
      const label = message.url ? `reply context message ${message.url}` : `reply context message ${message.messageId}`;
      const reference = discordAttachmentContextToReference(attachment, "reply_context", label);
      if (reference) references.push(reference);
    }
  }
  return references;
}

function discordAttachmentContextToReference(
  attachment: DiscordAttachmentContext,
  source: ImageReferenceContext["source"],
  labelPrefix: string,
): ImageReferenceContext | undefined {
  if (!isImageAttachmentLike(attachment) || !isSupportedImageReferenceUrl(attachment.url)) return undefined;
  const bits = [
    attachment.filename ?? attachment.id,
    attachment.contentType,
    attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : undefined,
    attachment.description ? `description=${attachment.description}` : undefined,
  ].filter(Boolean);
  return { url: attachment.url, label: `${labelPrefix}: ${bits.join(" | ") || attachment.url}`, contentType: attachment.contentType, source };
}

function normalizeImageUrls(urls: string[] | undefined): string[] {
  return [...new Set((urls ?? []).map((url) => url.trim()).filter(isSupportedImageReferenceUrl))];
}

function dedupeImageReferences(references: ImageReferenceContext[]) {
  return references.filter((reference, index) => references.findIndex((candidate) => candidate.url === reference.url) === index);
}

function isImageAttachmentLike(attachment: Pick<DiscordAttachmentContext, "url" | "filename" | "contentType">) {
  return isSupportedImageReferenceUrl(attachment.url) && (attachment.contentType?.toLowerCase().startsWith("image/") ||
    /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(attachment.filename ?? attachment.url));
}

function isSupportedImageReferenceUrl(value: string | null | undefined): value is string {
  return Boolean(value && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)));
}
