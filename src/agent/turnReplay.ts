/** Rebuilds the reply context of a retained turn envelope so a past turn can be replayed under its original scope. */
type PrivateReplayReplyContextMessage = {
  messageId: string;
  channelId: string;
  content: string;
  authorIsBot: boolean;
  attachmentSummaries: string[];
  attachments: unknown[];
  [key: string]: unknown;
};

type PrivateReplayReplyContext = PrivateReplayReplyContextMessage & {
  rootMessageId: string;
  chain: PrivateReplayReplyContextMessage[];
};

type PrivateReplayTurnEnvelope = {
  requestKind?: unknown;
  guildId: string;
  channelId: string;
  userId: string;
  visibleChannelIds: string[];
  replyContext: unknown;
  requestAttachments: unknown;
  requestEmbeds?: unknown;
  interaction?: unknown;
};

export function hasFaithfulPrivateReplayContext(input: {
  requestKind?: unknown;
  replyContext: unknown;
  requestAttachments: unknown;
  requestEmbeds?: unknown;
  interaction?: unknown;
}): boolean {
  return input.requestKind === "message"
    && (input.replyContext == null || isRetainedReplyContext(input.replyContext))
    && !nonEmptyArray(input.requestAttachments)
    && !nonEmptyArray(input.requestEmbeds)
    && input.interaction == null;
}

export function privateReplayReplyContextFromEnvelope(
  envelope: PrivateReplayTurnEnvelope,
  scope: { guildId: string; channelId: string; userId: string; visibleChannelIds: readonly string[] },
): PrivateReplayReplyContext | undefined {
  if (envelope.guildId !== scope.guildId || envelope.channelId !== scope.channelId || envelope.userId !== scope.userId) {
    throw new Error("Retained private-replay context does not match the requested Discord scope.");
  }
  if (!sameStrings(envelope.visibleChannelIds, scope.visibleChannelIds)) {
    throw new Error("Retained private-replay context does not match the requested visible-channel scope.");
  }
  if (!hasFaithfulPrivateReplayContext(envelope)) {
    throw new Error("Retained Discord context cannot be replayed faithfully.");
  }
  return envelope.replyContext == null ? undefined : isRetainedReplyContext(envelope.replyContext)
    ? envelope.replyContext
    : undefined;
}

function nonEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function isRetainedReplyContext(value: unknown): value is PrivateReplayReplyContext {
  if (!isReplyContextMessage(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.rootMessageId === "string"
    && Array.isArray(record.chain)
    && record.chain.every(isReplyContextMessage);
}

function isReplyContextMessage(value: unknown): value is PrivateReplayReplyContextMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.messageId === "string"
    && typeof record.channelId === "string"
    && typeof record.content === "string"
    && typeof record.authorIsBot === "boolean"
    && Array.isArray(record.attachmentSummaries)
    && record.attachmentSummaries.every((item) => typeof item === "string")
    && Array.isArray(record.attachments);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
