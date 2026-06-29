import type { Message, TextBasedChannel } from "discord.js";
import { normalizeMessageContent } from "../memory/normalize.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";

export async function persistDiscordMessage(repo: DiscordAiAgentRepository, message: Message) {
  if (!message.inGuild()) return;
  if (message.partial) {
    message = await message.fetch();
  }
  const guild = message.guild;
  if (!guild) return;

  await repo.upsertGuild({
    id: guild.id,
    name: guild.name,
    raw: { id: guild.id, name: guild.name }
  });

  await repo.upsertChannel(channelRecordFromMessage(message));

  await repo.upsertMessage({
    id: message.id,
    guildId: guild.id,
    channelId: message.channel.id,
    threadId: isThreadLike(message.channel) ? message.channel.id : null,
    authorId: message.author.id,
    authorUsername: message.author.username,
    authorGlobalName: message.author.globalName,
    authorIsBot: message.author.bot,
    authorRaw: {
      id: message.author.id,
      username: message.author.username,
      globalName: message.author.globalName,
      bot: message.author.bot
    },
    content: message.content ?? "",
    normalizedContent: normalizeMessageContent(message.content ?? ""),
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    raw: {
      id: message.id,
      type: message.type,
      system: message.system,
      pinned: message.pinned,
      url: message.url,
      reference: message.reference
        ? {
            messageId: message.reference.messageId ?? null,
            channelId: message.reference.channelId ?? null,
            guildId: message.reference.guildId ?? null
          }
        : null,
      reactions: reactionSummariesFromMessage(message)
    },
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      url: attachment.url,
      proxyUrl: attachment.proxyURL,
      filename: attachment.name,
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
      raw: {
        width: attachment.width,
        height: attachment.height,
        description: attachment.description
      }
    }))
  });
}

export function channelRecordFromMessage(message: Message) {
  const channel = message.channel as TextBasedChannel & {
    id: string;
    name?: string;
    type: number;
    parentId?: string | null;
    isThread?: () => boolean;
  };

  return {
    id: channel.id,
    guildId: message.guildId!,
    parentId: channel.parentId ?? null,
    name: channel.name ?? null,
    type: channel.type,
    isThread: Boolean(channel.isThread?.()),
    raw: {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId ?? null
    }
  };
}

function isThreadLike(channel: TextBasedChannel): boolean {
  return Boolean((channel as { isThread?: () => boolean }).isThread?.());
}

export function reactionSummariesFromMessage(message: Pick<Message, "reactions">) {
  const reactions = (message.reactions as any)?.cache?.values?.();
  if (!reactions) return [];

  return [...reactions].map((reaction: any) => ({
    emojiId: reaction.emoji?.id ?? null,
    emojiName: reaction.emoji?.name ?? null,
    animated: Boolean(reaction.emoji?.animated),
    count: Number(reaction.count ?? 0),
    me: Boolean(reaction.me),
    countDetails: reaction.countDetails ?? null
  }));
}
