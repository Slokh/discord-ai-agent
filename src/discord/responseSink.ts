import { AttachmentBuilder, type Client, type Message } from "discord.js";
import type { Logger } from "pino";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentFile } from "../tools/types.js";

export const DEFAULT_DISCORD_LOADING_REACTION = "<a:loading:1521299407214084337>";
const ACKNOWLEDGEMENT_FALLBACK_CONTENT = "Working on it...";

export type DiscordResponseResult = {
  message: Message;
  usedStatusMessage: boolean;
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
      this.loadingReaction = await this.sourceMessage.react(this.loadingReactionEmoji);
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
      this.statusMessage = await this.statusMessage.edit(cleanContent);
      return this.statusMessage;
    }
    this.statusMessage = await this.sourceMessage.reply(cleanContent);
    return this.statusMessage;
  }

  async sendFinal(input: { content: string; files?: AgentFile[] }): Promise<DiscordResponseResult> {
    const files = input.files?.map((file) => new AttachmentBuilder(file.data, { name: file.name }));
    const payload = files?.length ? { content: input.content, files } : { content: input.content };
    const usedStatusMessage = Boolean(this.statusMessage);
    const message = this.statusMessage ? await this.statusMessage.edit(payload) : await this.sourceMessage.reply(payload);
    this.statusMessage = message;
    await this.clearAcknowledgement();
    return { message, usedStatusMessage };
  }

  async sendError(content: string): Promise<DiscordResponseResult> {
    const result = await this.sendFinal({ content: cleanResponse(content, this.maxReplyChars) });
    return result;
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
      await reaction.users.remove(botUserId);
      this.logger.debug({ emoji: this.loadingReactionEmoji }, "Removed Discord loading reaction");
    } catch (error) {
      this.logger.warn({ err: error, emoji: this.loadingReactionEmoji }, "Failed to remove Discord loading reaction");
    }
  }
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
