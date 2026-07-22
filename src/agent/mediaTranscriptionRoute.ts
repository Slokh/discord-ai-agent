import type { ToolContext } from "../tools/types.js";
import { singlePublicXVideoUrlInRequestScope } from "../tools/publicMedia.js";

const TRANSCRIPTION_INTENT = /\b(?:transcrib(?:e|es|ed|ing)|transcription|speech[- ]to[- ]text|subtitles?|captions?)\b/i;

export function mediaTranscriptionToolForPrompt(
  ctx: ToolContext,
  userText: string,
): "inspectDiscordFile" | null {
  const replyMessages = ctx.replyContext
    ? (ctx.replyContext.chain.length > 0 ? ctx.replyContext.chain : [ctx.replyContext])
    : [];
  const contextText = [userText, ...replyMessages.map((message) => message.content)].join("\n");
  if (!TRANSCRIPTION_INTENT.test(contextText)) return null;
  const hasAttachment = (ctx.requestAttachments?.length ?? 0) > 0 ||
    replyMessages.some((message) => message.attachments.length > 0);
  const hasPublicXVideo = Boolean(singlePublicXVideoUrlInRequestScope(
    userText,
    replyMessages.map((message) => message.content),
  ));
  return hasAttachment || hasPublicXVideo ? "inspectDiscordFile" : null;
}
