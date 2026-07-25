import type { ChatMessage } from "../models/openrouter.js";
import type { DiscordAttachmentContext, DiscordReplyContext, ToolContext } from "../tools/types.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export { ImageGenerationGuard } from "./imageGenerationGuard.js";

export const IMAGE_EVIDENCE_RETRY_GUIDANCE =
  "A permission-visible Discord image is already available in the current request or reply chain. " +
  "The previous draft incorrectly claimed the image was unavailable. Call inspectDiscordImages now with useContextImages=true and answer the current visual question from that result. Do not ask for a re-upload.";

export class ImageEvidenceGuard {
  private attempted = false;
  private forceInspection = false;

  constructor(private readonly ctx: ToolContext) {}

  takeForcedTool() {
    if (!this.forceInspection) return null;
    this.forceInspection = false;
    return "inspectDiscordImages" as const;
  }

  async retryDraft(content: string, messages: ChatMessage[], round: number) {
    if (this.attempted || !shouldRetryFalseImageRefusal(this.ctx, content)) {
      return false;
    }
    this.attempted = true;
    this.forceInspection = true;
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: IMAGE_EVIDENCE_RETRY_GUIDANCE });
    await recordAgentEvent(this.ctx, {
      eventName: "agent.image_evidence.retry",
      level: "warn",
      summary: "Retrying a false image-access refusal with visible reply context",
      metadata: { round, forcedToolName: "inspectDiscordImages" },
    });
    return true;
  }
}

export function shouldRetryFalseImageRefusal(
  ctx: ToolContext,
  content: string,
) {
  if (!hasContextImage(ctx.requestAttachments, ctx.replyContext)) return false;
  const normalized = content.replace(/[’]/g, "'").toLowerCase();
  const imageSubject =
    /\b(?:image|picture|photo|screenshot|diagram|chart|meme|visual|attachment)\b/;
  const inaccessibleClaim =
    /\b(?:can(?:not|'t)|unable to|not able to)\b.{0,100}\b(?:see|view|access|inspect|open|analy[sz]e|read)\b/s.test(normalized) ||
    /\b(?:do not|don't)\s+have\s+(?:direct\s+)?access\b/s.test(normalized) ||
    /\b(?:image|picture|photo|screenshot|attachment)\b.{0,80}\b(?:is not|isn't|was not|wasn't)\s+(?:available|accessible|visible)\b/s.test(normalized) ||
    /\b(?:re-?upload|upload|attach|send)\b.{0,80}\b(?:image|picture|photo|screenshot|attachment)\b.{0,40}\b(?:again|here)\b/s.test(normalized);
  return imageSubject.test(normalized) && inaccessibleClaim;
}

function hasContextImage(
  requestAttachments: DiscordAttachmentContext[] | undefined,
  replyContext: DiscordReplyContext | null | undefined,
) {
  return [
    ...(requestAttachments ?? []),
    ...(replyContext?.chain.flatMap((message) => message.attachments) ?? []),
  ].some(isImageAttachment);
}

function isImageAttachment(
  attachment: DiscordAttachmentContext | null | undefined,
) {
  if (!attachment) return false;
  return attachment.contentType?.toLowerCase().startsWith("image/") ||
    /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(
      attachment.filename ?? attachment.url,
    );
}
