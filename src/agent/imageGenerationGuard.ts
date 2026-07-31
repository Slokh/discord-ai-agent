import type { ConversationMessage } from "../db/repositories.js";
import type { ChatMessage } from "../models/openrouter.js";
import type {
  DiscordAttachmentContext,
  DiscordReplyContext,
  ToolContext,
} from "../tools/types.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export const IMAGE_GENERATION_RETRY_GUIDANCE =
  "The current request explicitly asks for an image to be generated or edited. " +
  "Do not answer with a capability refusal or a text-only prompt. Call generateImage now. " +
  "Use current/reply images as references when present, and use retained conversation context only to resolve the requested visual changes.";

export class ImageGenerationGuard {
  private readonly requested: boolean;
  private recoveryAttempted = false;
  private forceGeneration = false;

  constructor(
    private readonly ctx: ToolContext,
    userText: string,
  ) {
    this.requested = hasExplicitImageGenerationIntent(ctx, userText);
  }

  takeForcedTool() {
    if (!this.forceGeneration) return null;
    this.forceGeneration = false;
    return "generateImage" as const;
  }

  async retryDraft(
    content: string,
    messages: ChatMessage[],
    round: number,
    generationAttempted = false,
  ) {
    if (
      !this.requested ||
      this.recoveryAttempted ||
      generationAttempted
    ) {
      return false;
    }
    this.recoveryAttempted = true;
    this.forceGeneration = true;
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: IMAGE_GENERATION_RETRY_GUIDANCE });
    await recordAgentEvent(this.ctx, {
      eventName: "agent.image_generation.retry",
      level: "warn",
      summary: "Retrying an unfulfilled image-generation request",
      metadata: { round, forcedToolName: "generateImage" },
    });
    return true;
  }
}

export function hasExplicitImageGenerationIntent(
  ctx: Pick<
    ToolContext,
    "requestAttachments" | "replyContext" | "sessionMessages"
  >,
  userText: string,
) {
  const normalized = userText.trim().replace(/[’]/g, "'").toLowerCase();
  if (!normalized || IMAGE_INSTRUCTIONAL_QUESTION.test(normalized)) {
    return false;
  }

  const hasCreationCommand = IMAGE_CREATION_COMMAND.test(normalized);
  const hasEditCommand = IMAGE_EDIT_COMMAND.test(normalized);
  if (
    (hasCreationCommand || hasEditCommand) &&
    IMAGE_OUTPUT_NOUN.test(normalized)
  ) {
    return true;
  }
  if (IMAGE_DIRECT_RENDER_COMMAND.test(normalized)) return true;

  const hasVisualContext = contextHasImageAttachment(
    ctx.requestAttachments,
    ctx.replyContext,
  ) || conversationHasImageGenerationContext(
    ctx.sessionMessages,
    ctx.replyContext,
  );
  if (!hasVisualContext) return false;

  return (
    hasEditCommand ||
    IMAGE_CORRECTION_FEEDBACK.test(normalized) ||
    (
      hasCreationCommand &&
      IMAGE_FOLLOW_UP_REFERENCE.test(normalized)
    )
  );
}

const IMAGE_OUTPUT_NOUN =
  /\b(?:image|picture|pic|photo|photograph|illustration|graphic|artwork|avatar|pfp|logo|poster|meme|sticker|emoji|emote|wallpaper|banner|thumbnail|drawing|painting|render)\b/i;
const IMAGE_CREATION_COMMAND =
  /^(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:make|create|generate|design|produce)\b/i;
const IMAGE_EDIT_COMMAND =
  /^(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:edit|modify|transform|remake|recreate|restyle|convert|turn|change)\b/i;
const IMAGE_DIRECT_RENDER_COMMAND =
  /^(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:draw|paint|sketch|illustrate|render)\b/i;
const IMAGE_FOLLOW_UP_REFERENCE =
  /\b(?:it|this|that|one|another|same|version|again|more)\b/i;
const IMAGE_CORRECTION_FEEDBACK =
  /^(?:no|not quite|try again)\b|\b(?:doesn't|does not|didn't|did not)\b|\bnot\b.{0,100}\b(?:same|reference|subject|person|character|face|him|her|them|this|that)\b/i;
const IMAGE_INSTRUCTIONAL_QUESTION =
  /^(?:how|why|what|when|where|which|who)\b|^(?:can|could|would)\s+(?:i|someone|a user)\b/i;

function contextHasImageAttachment(
  requestAttachments: DiscordAttachmentContext[] | undefined,
  replyContext: DiscordReplyContext | null | undefined,
) {
  const replyMessages = replyContext
    ? (replyContext.chain.length > 0 ? replyContext.chain : [replyContext])
    : [];
  return [
    ...(requestAttachments ?? []),
    ...replyMessages.flatMap((message) => message.attachments),
  ].some(isImageAttachment);
}

function conversationHasImageGenerationContext(
  sessionMessages: ConversationMessage[] | undefined,
  replyContext: DiscordReplyContext | null | undefined,
) {
  const recentSession = (sessionMessages ?? []).slice(-12);
  const replyMessages = replyContext
    ? (replyContext.chain.length > 0 ? replyContext.chain : [replyContext])
    : [];
  if (recentSession.some((message) =>
    message.metadata?.toolName === "generateImage"
  )) {
    return true;
  }
  const contextText = [
    ...recentSession.map((message) => message.content),
    ...replyMessages.map((message) => message.content),
  ].join("\n").toLowerCase();
  return IMAGE_OUTPUT_NOUN.test(contextText) &&
    (
      IMAGE_GENERATION_CONTEXT.test(contextText) ||
      /\bgenerated image for\b/i.test(contextText)
    );
}

const IMAGE_GENERATION_CONTEXT =
  /\b(?:make|create|generate|draw|paint|sketch|illustrate|render|edit|modify|transform|remake|recreate|restyle)\b/i;

function isImageAttachment(
  attachment: DiscordAttachmentContext | null | undefined,
) {
  if (!attachment) return false;
  return attachment.contentType?.toLowerCase().startsWith("image/") ||
    /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(
      attachment.filename ?? attachment.url,
    );
}
