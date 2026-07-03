import { AttachmentBuilder, type Client, type Message } from "discord.js";
import type { Logger } from "pino";
import { cleanResponse } from "../tools/coreTools.js";
import type { AgentFile } from "../tools/types.js";

export const DISCORD_LOADING_EMOJI_ID = "1521299407214084337";
export const DISCORD_LOADING_EMOJI = `<a:loading:${DISCORD_LOADING_EMOJI_ID}>`;

export type DiscordResponseResult = {
  message: Message;
  usedStatusMessage: boolean;
};

export class DiscordResponseSink {
  private readonly client: Client;
  private readonly sourceMessage: Message;
  private readonly maxReplyChars: number;
  private readonly logger: Logger;
  private statusMessage: Message | null;
  private loadingReaction: Awaited<ReturnType<Message["react"]>> | null = null;
  private acknowledgementAttempted = false;

  constructor(input: {
    client: Client;
    sourceMessage: Message;
    maxReplyChars: number;
    logger: Logger;
    statusMessage?: Message | null;
  }) {
    this.client = input.client;
    this.sourceMessage = input.sourceMessage;
    this.maxReplyChars = input.maxReplyChars;
    this.logger = input.logger;
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
      this.loadingReaction = await this.sourceMessage.react(DISCORD_LOADING_EMOJI);
      this.logger.debug({ emojiId: DISCORD_LOADING_EMOJI_ID }, "Added Discord loading reaction");
    } catch (error) {
      this.logger.warn({ err: error, emojiId: DISCORD_LOADING_EMOJI_ID }, "Failed to add Discord loading reaction");
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
      this.sourceMessage.reactions.cache.get(DISCORD_LOADING_EMOJI_ID) ??
      this.sourceMessage.reactions.cache.find((candidate) => candidate.emoji.id === DISCORD_LOADING_EMOJI_ID);
    if (!reaction) return;
    try {
      await reaction.users.remove(botUserId);
      this.logger.debug({ emojiId: DISCORD_LOADING_EMOJI_ID }, "Removed Discord loading reaction");
    } catch (error) {
      this.logger.warn({ err: error, emojiId: DISCORD_LOADING_EMOJI_ID }, "Failed to remove Discord loading reaction");
    }
  }
}
