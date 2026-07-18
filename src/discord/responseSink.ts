import { AttachmentBuilder, type Client, type Message, type MessageCreateOptions } from "discord.js";
import type { Logger } from "pino";
import { cleanResponse, formatDiscordMarkdownTables } from "../tools/responseFormatting.js";
import { splitForDiscord } from "../util/text.js";
import type { AgentFile } from "../tools/types.js";
import { discordEdit, discordReact, discordRemoveReaction, discordReply, discordSend } from "./api.js";

export const DEFAULT_DISCORD_LOADING_REACTION = "⏳";
const ACKNOWLEDGEMENT_FALLBACK_CONTENT = "Working on it...";

export type DiscordResponseResult = {
  message: Message;
  usedStatusMessage: boolean;
};

export type DiscordResponseFooter = {
  traceUrl?: string | null;
  durationMs?: number | null;
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
  }) {
    this.client = input.client;
    this.sourceMessage = input.sourceMessage;
    this.maxReplyChars = input.maxReplyChars;
    this.logger = input.logger;
    this.loadingReactionEmoji = input.loadingReactionEmoji?.trim() || DEFAULT_DISCORD_LOADING_REACTION;
    this.loadingReactionMatch = parseDiscordReactionMatch(this.loadingReactionEmoji);
    this.statusMessage = input.statusMessage ?? null;
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
      try {
        await this.updateStatus(ACKNOWLEDGEMENT_FALLBACK_CONTENT);
      } catch (fallbackError) {
        this.logger.warn({ err: fallbackError }, "Failed to create fallback Discord acknowledgement status");
      }
    }
  }

  async updateStatus(content: string): Promise<Message> {
    const cleanContent = cleanResponse(content, this.maxReplyChars);
    if (this.statusMessage) {
      const edited = await discordEdit(this.statusMessage, cleanContent, { logger: this.logger });
      if (edited.ok) {
        this.statusMessage = edited.value;
        return this.statusMessage;
      }
      if (edited.reason !== "unknown_message") throw edited.error;
      this.logger.warn({ statusMessageId: this.statusMessage.id }, "Discord status message disappeared; creating a fresh reply");
      this.statusMessage = null;
    }
    const replied = await discordReply(this.sourceMessage, cleanContent, { logger: this.logger });
    if (!replied.ok) throw replied.error;
    this.statusMessage = replied.value;
    return this.statusMessage;
  }

  async sendFinal(input: { content: string; files?: AgentFile[]; footer?: DiscordResponseFooter | null }): Promise<DiscordResponseResult> {
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

    if (singleMessageContent.length <= this.maxReplyChars) {
      const payload = files?.length ? { content: singleMessageContent, files } : { content: singleMessageContent };
      const usedStatusMessage = Boolean(this.statusMessage);
      const message = await this.editStatusOrReply(payload);
      this.statusMessage = message;
      await this.clearAcknowledgement();
      return { message, usedStatusMessage };
    }

    const reservedForFooter = footerLine ? separator.length + footerLine.length : 0;
    const chunkLimit = Math.max(1, this.maxReplyChars - reservedForFooter);
    const chunks = splitForDiscord(body, chunkLimit);
    const usedStatusMessage = Boolean(this.statusMessage);
    const firstPayload = files?.length ? { content: chunks[0], files } : { content: chunks[0] };
    const firstMessage = await this.editStatusOrReply(firstPayload);
    this.statusMessage = firstMessage;

    const channel = this.sourceMessage.channel;
    const sendable = isSendableChannel(channel) ? channel : null;
    let previousMessageId = firstMessage.id;
    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const content = isLast && footerLine ? `${chunks[i]}${separator}${footerLine}` : chunks[i];
      if (!sendable) continue;
      if (content.length <= this.maxReplyChars) {
        const sentResult = await discordSend(sendable, this.continuationPayload(content, previousMessageId), { logger: this.logger });
        if (!sentResult.ok) throw sentResult.error;
        const sent = sentResult.value;
        previousMessageId = (sent as Message | undefined)?.id ?? previousMessageId;
      } else {
        for (const overflow of splitForDiscord(content, this.maxReplyChars)) {
          const sentResult = await discordSend(sendable, this.continuationPayload(overflow, previousMessageId), { logger: this.logger });
          if (!sentResult.ok) throw sentResult.error;
          const sent = sentResult.value;
          previousMessageId = (sent as Message | undefined)?.id ?? previousMessageId;
        }
      }
    }

    await this.clearAcknowledgement();
    return { message: firstMessage, usedStatusMessage };
  }

  async sendError(content: string, footer?: DiscordResponseFooter | null): Promise<DiscordResponseResult> {
    const result = await this.sendFinal({ content, footer });
    return result;
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

  private continuationPayload(content: string, referenceMessageId: string): MessageCreateOptions {
    return {
      content,
      reply: { messageReference: referenceMessageId, failIfNotExists: false },
      allowedMentions: { parse: [], repliedUser: false }
    };
  }

  private async editStatusOrReply(payload: string | MessageCreateOptions): Promise<Message> {
    if (this.statusMessage) {
      const edited = await discordEdit(this.statusMessage, payload as Parameters<Message["edit"]>[0], { logger: this.logger });
      if (edited.ok) return edited.value;
      if (edited.reason !== "unknown_message") throw edited.error;
      this.logger.warn({ statusMessageId: this.statusMessage.id }, "Discord status message disappeared; creating a fresh reply");
      this.statusMessage = null;
    }
    const replied = await discordReply(this.sourceMessage, payload, { logger: this.logger });
    if (!replied.ok) throw replied.error;
    return replied.value;
  }
}

export function formatDiscordResponseFooter(footer?: DiscordResponseFooter | null) {
  const lines: string[] = [];
  for (const extraLine of footer?.extraLines ?? []) {
    const trimmed = suppressDiscordFooterEmbeds(extraLine.trim());
    if (trimmed) lines.push(`-# ${trimmed}`);
  }
  const traceUrl = footer?.traceUrl?.trim();
  if (traceUrl) {
    const parts = [`[trace](<${traceUrl.replace(/^<|>$/g, "")}>)`];
    if (typeof footer?.durationMs === "number" && Number.isFinite(footer.durationMs)) {
      parts.push(formatFooterDuration(footer.durationMs));
    }
    lines.push(`-# ${parts.join(" · ")}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function suppressDiscordFooterEmbeds(value: string) {
  return value
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 <$2>")
    .replace(/(?<!<)https?:\/\/[^\s<>]+/g, "<$&>");
}

function formatFooterDuration(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(3)}s`;
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
