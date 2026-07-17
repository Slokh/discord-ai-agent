import type { Message, MessageSnapshot } from "discord.js";
import type { Logger } from "pino";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { DiscordAttachmentContext, DiscordReplyContext, DiscordReplyContextMessage } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { recordTraceEvent } from "./requestContext.js";

export const REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT = 24;
type UsableMessageSnapshot = MessageSnapshot & { id: string; channelId: string };

export async function resolveDiscordReplyContext(input: {
  repo: DiscordAiAgentRepository;
  message: Message;
  visibleChannelIds: string[];
  requestLogger: Logger;
}): Promise<DiscordReplyContext | undefined> {
  const directFirstChain: DiscordReplyContextMessage[] = [];
  const seenMessageIds = new Set<string>();
  let cursor: Message | UsableMessageSnapshot = input.message;

  const currentForward = discordForwardedMessageSnapshot(input.message);
  if (currentForward) {
    directFirstChain.push(discordReplyContextMessageFromMessage(currentForward, true));
    seenMessageIds.add(currentForward.id);
    cursor = currentForward;
  }

  for (let depth = 0; depth < REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT; depth += 1) {
    const reference = cursor.reference;
    if (!reference?.messageId) break;
    if (seenMessageIds.has(reference.messageId)) break;

    const referencedChannelId = reference.channelId ?? cursor.channelId ?? input.message.channelId;
    if (!input.visibleChannelIds.includes(referencedChannelId)) {
      input.requestLogger.warn(
        { referencedMessageId: reference.messageId, referencedChannelId, depth },
        "Skipping Discord reply context because requester cannot view a referenced channel"
      );
      await recordTraceEvent(input.repo, {
        eventName: "discord.reply_context.skipped",
        level: "warn",
        summary: "Referenced channel is not visible to requester",
        metadata: { referencedMessageId: reference.messageId, referencedChannelId, depth }
      });
      break;
    }

    let parent: Message;
    try {
      if (typeof cursor.fetchReference !== "function") break;
      parent = await cursor.fetchReference();
    } catch (error) {
      input.requestLogger.warn(
        { err: error, referencedMessageId: reference.messageId, referencedChannelId, depth },
        "Failed to fetch Discord reply chain parent"
      );
      await recordTraceEvent(input.repo, {
        eventName: "discord.reply_context.fetch_failed",
        level: "warn",
        summary: error instanceof Error ? error.message : String(error),
        metadata: { referencedMessageId: reference.messageId, referencedChannelId, depth }
      });
      break;
    }

    if (!parent.inGuild()) break;
    if (!input.visibleChannelIds.includes(parent.channelId)) {
      input.requestLogger.warn(
        { referencedMessageId: parent.id, referencedChannelId: parent.channelId, depth },
        "Stopping Discord reply context chain because requester cannot view the fetched parent channel"
      );
      break;
    }

    await persistDiscordMessage(input.repo, parent).catch((error) => {
      input.requestLogger.warn({ err: error, referencedMessageId: parent.id }, "Failed to persist Discord reply parent message");
    });

    const forwardedParent = discordForwardedMessageSnapshot(parent);
    const contextParent = forwardedParent ?? parent;
    seenMessageIds.add(parent.id);
    seenMessageIds.add(contextParent.id);
    directFirstChain.push(discordReplyContextMessageFromMessage(contextParent, Boolean(forwardedParent)));
    cursor = contextParent;
  }

  if (directFirstChain.length === 0) return undefined;
  const chain = [...directFirstChain].reverse();
  const directParent = directFirstChain[0];
  const rootMessageId = chain[0]?.messageId ?? directParent.messageId;
  const context: DiscordReplyContext = {
    ...directParent,
    rootMessageId,
    chain
  };

  input.requestLogger.info(
    {
      referencedMessageId: context.messageId,
      rootMessageId,
      replyChainLength: chain.length,
      referencedChannelId: context.channelId,
      referencedAuthorId: context.authorId,
      referencedContentPreview: previewText(context.content),
      attachmentCount: context.attachmentSummaries.length
    },
    "Resolved Discord reply chain context"
  );
  await recordTraceEvent(input.repo, {
    eventName: "discord.reply_context.resolved",
    summary: previewText(context.content) || "Resolved Discord reply chain",
    metadata: {
      referencedMessageId: context.messageId,
      rootMessageId,
      replyChainLength: chain.length,
      referencedChannelId: context.channelId,
      referencedAuthorId: context.authorId,
      attachmentCount: context.attachmentSummaries.length
    }
  });
  return context;
}

function discordReplyContextMessageFromMessage(message: Message | UsableMessageSnapshot, forwarded = false): DiscordReplyContextMessage {
  const attachments = discordAttachmentContextsFromMessage(message);
  return {
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author?.id ?? null,
    authorDisplayName: message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? null,
    authorIsBot: Boolean(message.author?.bot),
    content: message.content ?? "",
    attachmentSummaries: attachments.map(discordAttachmentSummary),
    attachments,
    createdAt: message.createdAt?.toISOString?.() ?? null,
    url: message.url ?? null,
    forwarded: forwarded || undefined
  };
}

export function discordForwardedMessageSnapshot(message: Pick<Message, "messageSnapshots">): UsableMessageSnapshot | null {
  const snapshots = message.messageSnapshots?.values?.();
  if (!snapshots) return null;
  const first = snapshots.next();
  if (first.done || !first.value?.id || !first.value.channelId) return null;
  return first.value as UsableMessageSnapshot;
}

export function discordAttachmentContextsFromMessage(message: Pick<Message, "attachments">): DiscordAttachmentContext[] {
  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    proxyUrl: attachment.proxyURL ?? null,
    filename: attachment.name ?? null,
    contentType: attachment.contentType ?? null,
    sizeBytes: attachment.size ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    description: attachment.description ?? null
  }));
}

function discordAttachmentSummary(attachment: DiscordAttachmentContext) {
  const dimensions = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : "";
  return [attachment.filename ?? attachment.id, attachment.contentType, dimensions, attachment.sizeBytes ? `${attachment.sizeBytes} bytes` : ""]
    .filter(Boolean)
    .join(" ");
}

export function isDiscordImageAttachment(attachment: DiscordAttachmentContext) {
  return isImageContentType(attachment.contentType) || /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|avif)$/i.test(attachment.filename ?? "");
}

function isImageContentType(contentType: string | null | undefined) {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("image/");
}
