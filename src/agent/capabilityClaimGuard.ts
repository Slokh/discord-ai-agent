import type { ToolContext } from "../tools/types.js";

const MEDIA_TRANSCRIPTION_GUIDANCE =
  "I can transcribe common audio and video attachments. Attach the media here or reply to the Discord message containing it, and I’ll transcribe it.";

export type CapabilityClaimCorrection = {
  content: string;
  corrected: boolean;
  capability?: "discord_media_transcription";
};

/**
 * Keep model-authored capability claims aligned with deterministic deployed
 * capabilities. This guard is intentionally narrow: it only corrects a hard
 * media-transcription refusal when the request has no attachment to inspect.
 */
export function correctKnownCapabilityClaim(
  ctx: ToolContext,
  userText: string,
  content: string,
): CapabilityClaimCorrection {
  if (hasDiscordAttachment(ctx)) return { content, corrected: false };

  const requestContext = [userText, ...replyContextText(ctx)].join("\n");
  if (!hasMediaTranscriptionIntent(requestContext)) {
    return { content, corrected: false };
  }
  if (!isFalseMediaTranscriptionRefusal(content)) {
    return { content, corrected: false };
  }

  return {
    content: MEDIA_TRANSCRIPTION_GUIDANCE,
    corrected: true,
    capability: "discord_media_transcription",
  };
}

function hasDiscordAttachment(ctx: ToolContext) {
  if ((ctx.requestAttachments?.length ?? 0) > 0) return true;
  const replyContext = ctx.replyContext;
  if (!replyContext) return false;
  const messages = replyContext.chain.length > 0
    ? replyContext.chain
    : [replyContext];
  return messages.some((message) => (message.attachments?.length ?? 0) > 0);
}

function replyContextText(ctx: ToolContext) {
  const replyContext = ctx.replyContext;
  if (!replyContext) return [];
  const messages = replyContext.chain.length > 0
    ? replyContext.chain
    : [replyContext];
  return messages.map((message) => message.content);
}

function hasMediaTranscriptionIntent(value: string) {
  return /\b(?:transcrib(?:e|es|ed|ing)|transcription|speech[- ]to[- ]text|subtitles?|captions?)\b/i.test(value);
}

function isFalseMediaTranscriptionRefusal(content: string) {
  const positiveCapability =
    /\b(?:i|we|this bot|the bot)\s+can\s+(?:directly\s+)?transcrib/i.test(content) ||
    /\b(?:audio|video|media)\s+transcription\s+is\s+supported\b/i.test(content);
  if (positiveCapability) return false;

  const inputSpecificLimitation =
    /\b(?:until|unless)\b.{0,100}\b(?:attach|upload|provide|reply)\b/is.test(content) ||
    /\bwithout\b.{0,80}\b(?:attachment|file|media|audio|video)\b/is.test(content);
  if (inputSpecificLimitation) return false;

  const capabilitySubject =
    /\b(?:transcrib(?:e|es|ed|ing)|transcription|speech[- ]to[- ]text|subtitles?|captions?|audio|video|media|recordings?|clips?)\b/i;
  const denialBeforeSubject =
    /\b(?:can(?:not|'t)|unable\s+to|not\s+able\s+to|do(?:es)?\s+not\s+support|doesn['’]t\s+support|don['’]t\s+support|unsupported|no\s+(?:ability|capability)\s+to)\b.{0,120}\b(?:transcrib(?:e|es|ed|ing)|transcription|speech[- ]to[- ]text|subtitles?|captions?|audio|video|media|recordings?|clips?)\b/is;
  const subjectBeforeDenial =
    /\b(?:transcrib(?:e|es|ed|ing)|transcription|speech[- ]to[- ]text|subtitles?|captions?|audio|video|media|recordings?|clips?)\b.{0,120}\b(?:is(?:n['’]t|\s+not)\s+supported|unsupported|can(?:not|'t)\s+be\s+(?:processed|transcribed|handled))\b/is;
  return capabilitySubject.test(content) &&
    (denialBeforeSubject.test(content) || subjectBeforeDenial.test(content));
}
