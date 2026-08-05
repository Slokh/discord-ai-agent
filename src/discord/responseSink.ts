import { createHash } from "node:crypto";
import { AttachmentBuilder, MessageFlags, type Client, type Message, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import type { Logger } from "pino";
import { cleanResponse, formatDiscordMarkdownTables } from "../tools/responseFormatting.js";
import { splitForDiscord } from "../util/text.js";
import type { AgentFile } from "../tools/types.js";
import { plainDiscordComponentsV2Payload, validateDiscordAttachmentNames, type PreparedDiscordPresentation } from "./components/renderer.js";
import { discordEdit, discordReact, discordRemoveReaction, discordReply, discordSend } from "./api.js";

export const DEFAULT_DISCORD_LOADING_REACTION = "⏳";

export type DiscordResponseResult = {
  message: Message;
  usedStatusMessage: boolean;
  usedRichPresentation: boolean;
  messageCount: number;
  continuationMessageIds: string[];
};

export type DiscordResponseFooter = {
  /** End-to-end request duration, rendered independently of any operator UI or trace link. */
  durationMs?: number;
  /** Extra subtext lines (e.g. RNG fairness proofs), each rendered as its own `-#` line. */
  extraLines?: string[];
};

export type DiscordReactionOutcome = {
  added: string[];
  failed: { emoji: string; err: unknown }[];
};

export type DiscordAddReactionsInput = {
  emojis: string[];
  message?: Message;
};

export class DiscordResponseSink {
  private readonly client: Client;
  private readonly sourceMessage: Message;
  private readonly maxReplyChars: number;
  private readonly logger: Logger;
  private readonly loadingReactionEmoji: string;
  private readonly loadingReactionMatch: DiscordReactionMatch;
  private readonly deliveryNonce: string | null;
  private readonly silentUntilFinal: boolean;
  private statusMessage: Message | null;
  private loadingReaction: Awaited<ReturnType<Message["react"]>> | null = null;
  private acknowledgementAttempted = false;

  constructor(input: {
    client: Client;
    sourceMessage: Message;
    maxReplyChars: number;
    logger: Logger;
    loadingReactionEmoji?: string;
    statusMessage?: Message | null;
    deliveryKey?: string | null;
    silentUntilFinal?: boolean;
  }) {
    this.client = input.client;
    this.sourceMessage = input.sourceMessage;
    this.maxReplyChars = input.maxReplyChars;
    this.logger = input.logger;
    this.loadingReactionEmoji = input.loadingReactionEmoji?.trim() || DEFAULT_DISCORD_LOADING_REACTION;
    this.loadingReactionMatch = parseDiscordReactionMatch(this.loadingReactionEmoji);
    this.deliveryNonce = input.deliveryKey ? discordDeliveryNonce(input.deliveryKey) : null;
    this.statusMessage = input.statusMessage ?? null;
    this.silentUntilFinal = input.silentUntilFinal ?? false;
  }

  get statusChannelId() {
    return this.statusMessage?.channelId;
  }

  get statusMessageId() {
    return this.statusMessage?.id;
  }

  get statusUrl() {
    return this.statusMessage?.url;
  }

  async acknowledge() {
    if (this.acknowledgementAttempted) return;
    this.acknowledgementAttempted = true;
    try {
      const reaction = await discordReact(this.sourceMessage, this.loadingReactionEmoji, { logger: this.logger });
      if (!reaction.ok) throw reaction.error;
      this.loadingReaction = reaction.value;
      this.logger.debug({ emoji: this.loadingReactionEmoji }, "Added Discord loading reaction");
    } catch (error) {
      this.logger.warn({ err: error, emoji: this.loadingReactionEmoji }, "Failed to add Discord loading reaction");
    }
  }

  async updateStatus(content: string): Promise<Message> {
    if (this.silentUntilFinal) {
      if (!this.statusMessage) throw new Error("Silent Discord response requires an existing message to replace at completion.");
      return this.statusMessage;
    }
    const cleanContent = cleanResponse(content, this.maxReplyChars);
    if (this.statusMessage) {
      const payload = this.statusUsesComponentsV2()
        ? plainDiscordComponentsV2Payload({ content: cleanContent })
        : cleanContent;
      const edited = await discordEdit(
        this.statusMessage,
        this.suppressMentions(payload) as Parameters<Message["edit"]>[0],
        { logger: this.logger },
      );
      if (edited.ok) {
        this.statusMessage = edited.value;
        return this.statusMessage;
      }
      if (edited.reason !== "unknown_message") throw edited.error;
      this.logger.warn({ statusMessageId: this.statusMessage.id }, "Discord status message disappeared; creating a fresh reply");
      this.statusMessage = null;
    }
    const replied = await discordReply(
      this.sourceMessage,
      this.withDeliveryNonce(this.suppressMentions(cleanContent) as MessageCreateOptions),
      { logger: this.logger },
    );
    if (!replied.ok) throw replied.error;
    this.statusMessage = replied.value;
    return this.statusMessage;
  }

  async sendFinal(input: { content: string; files?: AgentFile[]; footer?: DiscordResponseFooter | null; presentation?: PreparedDiscordPresentation | null }): Promise<DiscordResponseResult> {
    validateDiscordAttachmentNames(input.files?.map((file) => file.name) ?? []);
    const files = input.files?.map((file) => new AttachmentBuilder(file.data, { name: file.name }));
    const footerLine = formatDiscordResponseFooter(input.footer);
    const rawBody = input.content.trim() || "Done.";
    const body = formatDiscordMarkdownTables(rawBody);
    if (body !== rawBody) {
      this.logger.debug(
        { inputChars: rawBody.length, outputChars: body.length },
        "Normalized Markdown table formatting for Discord",
      );
    }
    const separator = "\n\n";
    const singleMessageContent = footerLine ? `${body}${separator}${footerLine}` : body;

    if (input.presentation) {
      const usedStatusMessage = Boolean(this.statusMessage);
      try {
        const richPayload = {
          ...input.presentation.payload,
          ...(files?.length ? { files } : {}),
        } as MessageCreateOptions;
        const message = await this.editStatusOrReply(richPayload);
        this.statusMessage = message;
        await this.clearAcknowledgement();
        return { message, usedStatusMessage, usedRichPresentation: true, messageCount: 1, continuationMessageIds: [] };
      } catch (error) {
        this.logger.warn({ err: error }, "Discord rejected rich presentation; falling back to plain response");
      }
    }

    if (this.statusUsesComponentsV2()) {
      const usedStatusMessage = true;
      const payload = {
        ...plainDiscordComponentsV2Payload({
          content: body,
          footer: footerLine,
          fileNames: input.files?.map((file) => file.name),
        }),
        ...(files?.length ? { files } : {}),
      } as MessageCreateOptions;
      const message = await this.editStatusOrReply(payload);
      this.statusMessage = message;
      await this.clearAcknowledgement();
      return { message, usedStatusMessage, usedRichPresentation: false, messageCount: 1, continuationMessageIds: [] };
    }

    if (singleMessageContent.length <= this.maxReplyChars) {
      const payload = files?.length ? { content: singleMessageContent, files } : { content: singleMessageContent };
      const usedStatusMessage = Boolean(this.statusMessage);
      const message = await this.editStatusOrReply(payload);
      this.statusMessage = message;
      await this.clearAcknowledgement();
      return { message, usedStatusMessage, usedRichPresentation: false, messageCount: 1, continuationMessageIds: [] };
    }

    // Body and footer are independently bounded. Reserving the entire footer
    // in every body chunk can collapse the body budget to one character when
    // a turn has many deterministic audit lines (for example RNG proofs).
    const chunks = splitForDiscord(body, this.maxReplyChars);
    if (footerLine) {
      const lastIndex = chunks.length - 1;
      const combined = `${chunks[lastIndex]}${separator}${footerLine}`;
      if (combined.length <= this.maxReplyChars) chunks[lastIndex] = combined;
      else chunks.push(...splitForDiscord(footerLine, this.maxReplyChars));
    }
    const usedStatusMessage = Boolean(this.statusMessage);
    const firstPayload = files?.length ? { content: chunks[0], files } : { content: chunks[0] };
    const firstMessage = await this.editStatusOrReply(firstPayload);
    this.statusMessage = firstMessage;

    const channel = this.sourceMessage.channel;
    const sendable = isSendableChannel(channel) ? channel : null;
    let previousMessageId = firstMessage.id;
    let continuationIndex = 1;
    const continuationMessageIds: string[] = [];
    for (let i = 1; i < chunks.length; i++) {
      const content = chunks[i]!;
      if (!sendable) continue;
      const sentResult = await discordSend(sendable, this.continuationPayload(content, previousMessageId, continuationIndex++), { logger: this.logger });
      if (!sentResult.ok) throw sentResult.error;
      const sent = sentResult.value;
      previousMessageId = (sent as Message | undefined)?.id ?? previousMessageId;
      continuationMessageIds.push(previousMessageId);
    }

    await this.clearAcknowledgement();
    return {
      message: firstMessage,
      usedStatusMessage,
      usedRichPresentation: false,
      messageCount: 1 + continuationMessageIds.length,
      continuationMessageIds,
    };
  }

  async sendError(content: string, footer?: DiscordResponseFooter | null): Promise<DiscordResponseResult> {
    const result = await this.sendFinal({ content, footer });
    return result;
  }

  async replaceRichPresentationWithFallback(presentation: PreparedDiscordPresentation): Promise<Message | null> {
    if (!this.statusMessage) return null;
    const edited = await discordEdit(
      this.statusMessage,
      this.suppressMentions(presentation.fallbackPayload) as Parameters<Message["edit"]>[0],
      { logger: this.logger },
    );
    if (!edited.ok) {
      this.logger.error({ err: edited.error, statusMessageId: this.statusMessage.id }, "Failed to replace inactive Discord controls with a safe fallback");
      return null;
    }
    this.statusMessage = edited.value;
    return this.statusMessage;
  }

  async addReactions(input: DiscordAddReactionsInput): Promise<DiscordReactionOutcome> {
    const emojis = (input.emojis ?? [])
      .map((emoji) => emoji?.trim())
      .filter((emoji): emoji is string => Boolean(emoji));
    const target = input.message ?? this.statusMessage;
    const outcome: DiscordReactionOutcome = { added: [], failed: [] };
    if (!target) {
      this.logger.warn({ emojis }, "Cannot add Discord reactions: no target message available");
      for (const emoji of emojis) {
        outcome.failed.push({ emoji, err: new Error("no target message available") });
      }
      return outcome;
    }
    for (const emoji of emojis) {
      try {
        const result = await discordReact(target, emoji, { logger: this.logger });
        if (!result.ok) throw result.error;
        outcome.added.push(emoji);
        this.logger.debug({ emoji }, "Added Discord reaction");
      } catch (error) {
        outcome.failed.push({ emoji, err: error });
        this.logger.warn({ err: error, emoji }, "Failed to add Discord reaction");
      }
    }
    return outcome;
  }

  async addSourceMessageReactions(emojis: string[]): Promise<DiscordReactionOutcome> {
    return this.addReactions({ emojis, message: this.sourceMessage });
  }

  async clearAcknowledgement() {
    const botUserId = this.client.user?.id;
    if (!botUserId) return;
    const reaction =
      this.loadingReaction ??
      this.sourceMessage.reactions.cache.get(this.loadingReactionMatch.cacheKey) ??
      this.sourceMessage.reactions.cache.find((candidate) => reactionMatches(candidate, this.loadingReactionMatch));
    if (!reaction) return;
    try {
      const result = await discordRemoveReaction(reaction, botUserId, { logger: this.logger });
      if (!result.ok) throw result.error;
      this.logger.debug({ emoji: this.loadingReactionEmoji }, "Removed Discord loading reaction");
    } catch (error) {
      this.logger.warn({ err: error, emoji: this.loadingReactionEmoji }, "Failed to remove Discord loading reaction");
    }
  }

  private continuationPayload(content: string, referenceMessageId: string, index: number): MessageCreateOptions {
    return {
      content,
      reply: { messageReference: referenceMessageId, failIfNotExists: false },
      allowedMentions: { parse: [], repliedUser: false },
      ...this.nonceFields(index),
    };
  }

  private async editStatusOrReply(payload: string | MessageCreateOptions): Promise<Message> {
    const safePayload = this.suppressMentions(payload) as MessageCreateOptions;
    if (this.statusMessage) {
      const edited = await discordEdit(this.statusMessage, safePayload as Parameters<Message["edit"]>[0], { logger: this.logger });
      if (edited.ok) return edited.value;
      if (edited.reason !== "unknown_message") throw edited.error;
      this.logger.warn({ statusMessageId: this.statusMessage.id }, "Discord status message disappeared; creating a fresh reply");
      this.statusMessage = null;
    }
    const replied = await discordReply(this.sourceMessage, this.withDeliveryNonce(safePayload), { logger: this.logger });
    if (!replied.ok) throw replied.error;
    return replied.value;
  }

  private statusUsesComponentsV2() {
    return Boolean(this.statusMessage?.flags.has(MessageFlags.IsComponentsV2));
  }

  private withDeliveryNonce(payload: string | MessageCreateOptions, index = 0): string | MessageCreateOptions {
    if (!this.deliveryNonce) return payload;
    const normalized = typeof payload === "string" ? { content: payload } : payload;
    return { ...normalized, ...this.nonceFields(index) };
  }

  private suppressMentions(
    payload: string | MessageCreateOptions | MessageEditOptions,
  ): MessageCreateOptions | MessageEditOptions {
    const normalized = typeof payload === "string" ? { content: payload } : payload;
    return {
      ...normalized,
      allowedMentions: { parse: [], repliedUser: false },
    };
  }

  private nonceFields(index: number): Pick<MessageCreateOptions, "nonce" | "enforceNonce"> {
    return this.deliveryNonce ? { nonce: `${this.deliveryNonce}${index.toString(36).padStart(2, "0")}`, enforceNonce: true } : {};
  }
}

export function discordDeliveryNonce(deliveryKey: string): string {
  return createHash("sha256").update(deliveryKey).digest("hex").slice(0, 20);
}

export function formatDiscordResponseFooter(footer?: DiscordResponseFooter | null) {
  const lines: string[] = [];
  for (const extraLine of footer?.extraLines ?? []) {
    const trimmed = suppressDiscordFooterEmbeds(extraLine.trim());
    if (trimmed) lines.push(`-# ${trimmed}`);
  }
  if (typeof footer?.durationMs === "number" && Number.isFinite(footer.durationMs)) {
    lines.push(`-# ${formatFooterDuration(footer.durationMs)}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function formatFooterDuration(durationMs: number) {
  const boundedMs = Math.max(0, durationMs);
  const tenths = Math.round(boundedMs / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const totalSeconds = Math.round(boundedMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${totalSeconds % 60}s`;
}

function suppressDiscordFooterEmbeds(value: string) {
  return value
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 <$2>")
    .replace(/(?<!<)https?:\/\/[^\s<>]+/g, "<$&>");
}

type DiscordReactionMatch = {
  cacheKey: string;
  id: string | null;
  name: string;
};

function parseDiscordReactionMatch(value: string): DiscordReactionMatch {
  const custom = /^<a?:([^:>]+):(\d+)>$/.exec(value.trim());
  if (custom) {
    return {
      cacheKey: custom[2] ?? value,
      id: custom[2] ?? null,
      name: custom[1] ?? value
    };
  }
  return {
    cacheKey: value,
    id: null,
    name: value
  };
}

function reactionMatches(reaction: Awaited<ReturnType<Message["react"]>>, expected: DiscordReactionMatch) {
  if (expected.id && reaction.emoji.id === expected.id) return true;
  return reaction.emoji.name === expected.name;
}

function isSendableChannel(channel: Message["channel"]): channel is Extract<Message["channel"], { send: (options: MessageCreateOptions) => Promise<unknown> }> {
  return typeof (channel as { send?: unknown }).send === "function";
}
