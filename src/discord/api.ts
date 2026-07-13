import type { Client, GuildMember, Message, MessageCreateOptions, MessageEditOptions, MessagePayload, MessageReaction } from "discord.js";
import type { Logger } from "pino";
import type { DiscordAttachmentContext, DiscordUserAvatarResult } from "../tools/types.js";
import { logger as defaultLogger } from "../util/logger.js";
import { discordRetryDelayMs, retryAfterMsFromDiscordError } from "./crawler.js";

export type DiscordWriteFailureReason = "unknown_message" | "missing_access" | "missing_permissions" | "rate_limited";
export type DiscordWriteResult<T> = { ok: true; value: T } | { ok: false; reason: DiscordWriteFailureReason; error: unknown; retryAfterMs?: number };

export type DiscordWriteOptions = { logger: Logger; retries?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> };

type ReplyPayload = string | MessagePayload | MessageCreateOptions;
type EditPayload = string | MessagePayload | MessageEditOptions;

export async function discordReply(message: Pick<Message, "reply">, payload: ReplyPayload, options: DiscordWriteOptions): Promise<DiscordWriteResult<Message>> {
  return discordWrite(() => message.reply(payload as any) as Promise<Message>, options, "reply");
}

export async function discordEdit(message: Pick<Message, "edit">, payload: EditPayload, options: DiscordWriteOptions): Promise<DiscordWriteResult<Message>> {
  return discordWrite(() => message.edit(payload as any) as Promise<Message>, options, "edit");
}

export async function discordSend(channel: { send: (payload: MessageCreateOptions) => Promise<Message> }, payload: MessageCreateOptions, options: DiscordWriteOptions): Promise<DiscordWriteResult<Message>> {
  return discordWrite(() => channel.send(payload), options, "send");
}

export async function discordReact(message: Pick<Message, "react">, emoji: string, options: DiscordWriteOptions): Promise<DiscordWriteResult<MessageReaction>> {
  return discordWrite(() => message.react(emoji), options, "react");
}

export async function discordRemoveReaction(reaction: { users: { remove: (userId: string) => Promise<unknown> } }, userId: string, options: DiscordWriteOptions): Promise<DiscordWriteResult<unknown>> {
  return discordWrite(() => reaction.users.remove(userId), options, "remove_reaction");
}

export async function discordDeleteMessage(messages: { delete: (messageId: string) => Promise<unknown> }, messageId: string, options: DiscordWriteOptions): Promise<DiscordWriteResult<unknown>> {
  return discordWrite(() => messages.delete(messageId), options, "delete");
}

export async function discordWrite<T>(operation: () => Promise<T>, options: DiscordWriteOptions, action = "write"): Promise<DiscordWriteResult<T>> {
  const retryOptions = { retries: options.retries ?? 2, baseDelayMs: options.baseDelayMs ?? 500, maxDelayMs: options.maxDelayMs ?? 5_000 };
  let attempt = 0;
  while (true) {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      const classification = classifyDiscordWriteError(error);
      if (classification === "unknown_message") return { ok: false, reason: classification, error };
      if (classification === "missing_access" || classification === "missing_permissions") {
        options.logger.warn({ err: error, action, reason: classification }, "Discord write failed due to access or permissions");
        return { ok: false, reason: classification, error };
      }
      const delayMs = discordRetryDelayMs(error, attempt, retryOptions);
      if (delayMs != null && attempt < retryOptions.retries) {
        attempt += 1;
        options.logger.warn({ err: error, action, attempt, delayMs }, "Retrying Discord write after retryable error");
        await (options.sleep ?? sleep)(delayMs);
        continue;
      }
      if (classification === "rate_limited") return { ok: false, reason: classification, error, retryAfterMs: retryAfterMsFromDiscordError(error) };
      throw error;
    }
  }
}

export function classifyDiscordWriteError(error: unknown): DiscordWriteFailureReason | null {
  const source = error as any;
  const code = Number(source?.code ?? source?.rawError?.code ?? source?.data?.code);
  const status = Number(source?.status ?? source?.response?.status);
  if (code === 10008) return "unknown_message";
  if (code === 50001) return "missing_access";
  if (code === 50013) return "missing_permissions";
  if (status === 429 || code === 429) return "rate_limited";
  return null;
}

function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }

export async function deleteDiscordMessageById(sourceMessage: Message, messageId: string): Promise<boolean> {
  const messages = (sourceMessage.channel as any).messages;
  if (!messages?.delete) return false;
  try {
    const result = await discordDeleteMessage(messages, messageId, { logger: defaultLogger });
    return result.ok;
  } catch (error) {
    defaultLogger.warn({ err: error, messageId }, "Failed to delete undone Discord reply");
    return false;
  }
}

export async function sendDiscordPollMessage(
  sourceMessage: Message,
  input: { question: string; answers: string[]; durationHours: number; allowMultiselect: boolean }
): Promise<{ messageId: string; channelId: string; url: string }> {
  const channel = sourceMessage.channel;
  const send = (channel as { send?: (...args: unknown[]) => Promise<Message> }).send;
  if (typeof send !== "function") {
    throw new Error("This channel does not support sending poll messages.");
  }
  try {
    const posted = await send.call(channel, {
      poll: {
        question: { text: input.question },
        answers: input.answers.map((text) => ({ text })),
        duration: input.durationHours,
        allowMultiselect: input.allowMultiselect
      }
    });
    return {
      messageId: posted.id,
      channelId: posted.channelId,
      url: posted.url
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Discord rejected the poll message: ${message}`);
  }
}

export async function fetchDiscordUserAvatar(
  client: Client,
  guildId: string,
  userId: string
): Promise<DiscordUserAvatarResult | null> {
  try {
    let member: GuildMember | null = null;
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
      member = await guild.members.fetch(userId).catch(() => null);
    } catch {
      member = null;
    }
    const user = member?.user ?? (await client.users.fetch(userId, { force: false }).catch(() => null));
    if (!user) return null;
    const avatarOptions = { extension: "png" as const, size: 1024 };
    const globalAvatarUrl = user.displayAvatarURL(avatarOptions);
    const memberAvatarUrl = member?.displayAvatarURL(avatarOptions) ?? globalAvatarUrl;
    return {
      avatarUrl: memberAvatarUrl,
      globalAvatarUrl: memberAvatarUrl === globalAvatarUrl ? null : globalAvatarUrl,
      username: user.username ?? null,
      globalName: user.globalName ?? null,
      isBot: Boolean(user.bot),
      hasCustomAvatar: Boolean(user.avatar ?? member?.avatar ?? false)
    };
  } catch (error) {
    defaultLogger.warn({ err: error, userId }, "Failed to fetch Discord user avatar");
    return null;
  }
}

export async function fetchDiscordAttachment(
  client: Client,
  input: { channelId: string; messageId: string; attachmentId: string }
): Promise<DiscordAttachmentContext | null> {
  try {
    const channel = await client.channels.fetch(input.channelId);
    const messages = (channel as { messages?: { fetch?: (messageId: string) => Promise<Message> } } | null)?.messages;
    if (!messages?.fetch) return null;
    const message = await messages.fetch(input.messageId);
    const attachment = message.attachments.get(input.attachmentId);
    if (!attachment) return null;
    return {
      id: attachment.id,
      url: attachment.url,
      proxyUrl: attachment.proxyURL,
      filename: attachment.name,
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
      width: attachment.width,
      height: attachment.height,
      description: attachment.description
    };
  } catch (error) {
    defaultLogger.warn(
      { err: error, channelId: input.channelId, messageId: input.messageId, attachmentId: input.attachmentId },
      "Failed to fetch Discord attachment metadata"
    );
    return null;
  }
}
