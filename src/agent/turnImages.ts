import type { DiscordAttachmentContext, ToolContext } from "../tools/types.js";
import { isDiscordImageAttachment } from "../capabilities/imageContext.js";

const MAX_INLINE_IMAGES = 4;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Images the model should see directly this turn: the current message's
 * attachments, then the direct reply parent's. nanocode accepts images only as
 * data URLs, so each is downloaded (bounded in count, size and time). An image
 * that cannot be loaded stays reachable through the image-inspection tool.
 */
export async function loadTurnImages(
  ctx: Pick<ToolContext, "requestAttachments" | "replyContext" | "abortSignal">,
  fetchImage: typeof fetch = fetch,
): Promise<string[]> {
  const candidates = [
    ...(ctx.requestAttachments ?? []),
    ...(ctx.replyContext?.chain?.[0]?.attachments ?? []),
  ].filter(isDiscordImageAttachment).slice(0, MAX_INLINE_IMAGES);
  const loaded = await Promise.all(candidates.map((attachment) => loadImage(attachment, fetchImage, ctx.abortSignal)));
  return loaded.filter((image): image is string => Boolean(image));
}

async function loadImage(
  attachment: DiscordAttachmentContext,
  fetchImage: typeof fetch,
  abortSignal: AbortSignal | undefined,
): Promise<string | null> {
  if (attachment.sizeBytes && attachment.sizeBytes > MAX_INLINE_IMAGE_BYTES) return null;
  try {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetchImage(attachment.proxyUrl ?? attachment.url, { signal });
    if (!response.ok) return null;
    const contentType = (response.headers.get("content-type") ?? attachment.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (!INLINE_IMAGE_TYPES.has(contentType)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_INLINE_IMAGE_BYTES) return null;
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
