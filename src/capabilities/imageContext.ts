import type { AgentPromptContribution } from "../agent/capabilityRuntime.js";
import type { DiscordAttachmentContext, DiscordReplyContext, ToolContext } from "../tools/types.js";

export function imageContextPromptContribution(ctx: ToolContext): AgentPromptContribution | undefined {
  const lines: string[] = [];
  const requestImages = (ctx.requestAttachments ?? []).filter(isDiscordImageAttachment);
  if (requestImages.length > 0) {
    lines.push("Current user message images:");
    lines.push(...requestImages.map((attachment, index) => `- current ${index + 1}: ${attachmentLabel(attachment)}`));
  }

  const replyImages = [...(ctx.replyContext?.chain ?? [])].reverse().flatMap((message) =>
    (message.attachments ?? [])
      .filter(isDiscordImageAttachment)
      .map((attachment) => ({ message, attachment })),
  );
  if (replyImages.length > 0) {
    lines.push("Reply-chain images (direct parent and newest references first):");
    lines.push(...replyImages.map(({ message, attachment }, index) => {
      const source = message.url ? `message ${message.url}` : `message ${message.messageId}`;
      return `- reply ${index + 1}: ${source}; ${attachmentLabel(attachment)}`;
    }));
  }

  if (lines.length === 0) return undefined;
  return {
    section: "image_context",
    stability: "turn",
    content:
      "Discord image attachments are available to installed capabilities for this request. Use the image-inspection capability to understand them, or the image-generation capability's explicit context-reference option to edit or reuse them.\n" +
      lines.join("\n"),
  };
}

export function replyContextAttachmentCount(replyContext: DiscordReplyContext | undefined) {
  return (replyContext?.chain ?? []).reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0,
  );
}

function isDiscordImageAttachment(attachment: DiscordAttachmentContext) {
  return attachment.contentType?.toLowerCase().startsWith("image/") ||
    /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)(?:[?#].*)?$/i.test(attachment.filename ?? attachment.url);
}

function attachmentLabel(attachment: DiscordAttachmentContext) {
  const dimensions = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : "";
  return [attachment.filename ?? attachment.id, attachment.contentType, dimensions, attachment.url]
    .filter(Boolean)
    .join(" | ");
}
