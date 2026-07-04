import type { GuildBasedChannel, GuildMember, Message, TextBasedChannel } from "discord.js";
import { normalizeMessageContent } from "../memory/normalize.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";

export async function persistDiscordMessage(repo: DiscordAiAgentRepository, message: Message) {
  if (!message.inGuild()) return;
  if (message.partial) {
    message = await message.fetch();
  }
  const guild = message.guild;
  if (!guild) return;

  if (await repo.isChannelExcluded(message.channel.id)) return;

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
    messageType: message.type,
    isPinned: message.pinned,
    referencedMessageId: message.reference?.messageId ?? null,
    referencedChannelId: message.reference?.channelId ?? null,
    referencedGuildId: message.reference?.guildId ?? null,
    memberDisplayName: message.member?.displayName ?? null,
    memberNickname: message.member?.nickname ?? null,
    memberRoles: guildMemberRoleIds(message.member),
    memberJoinedAt: message.member?.joinedAt ?? null,
    memberRaw: guildMemberSnapshot(message.member),
    raw: {
      id: message.id,
      type: message.type,
      system: message.system,
      pinned: message.pinned,
      url: message.url,
      createdTimestamp: message.createdTimestamp,
      editedTimestamp: message.editedTimestamp,
      cleanContent: message.cleanContent,
      flags: serializableSnapshot((message as any).flags),
      reference: message.reference
        ? {
            messageId: message.reference.messageId ?? null,
            channelId: message.reference.channelId ?? null,
            guildId: message.reference.guildId ?? null
          }
        : null,
      mentions: mentionSnapshot(message),
      embeds: collectionSnapshots(message.embeds),
      components: collectionSnapshots((message as any).components),
      stickers: collectionSnapshots((message as any).stickers?.values?.() ? [...(message as any).stickers.values()] : []),
      poll: serializableSnapshot((message as any).poll),
      messageSnapshots: collectionSnapshots((message as any).messageSnapshots?.values?.() ? [...(message as any).messageSnapshots.values()] : []),
      interactionMetadata: serializableSnapshot((message as any).interactionMetadata),
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
        id: attachment.id,
        width: attachment.width,
        height: attachment.height,
        description: attachment.description,
        durationSeconds: (attachment as any).duration,
        ephemeral: (attachment as any).ephemeral,
        flags: serializableSnapshot((attachment as any).flags),
        title: (attachment as any).title,
        waveform: (attachment as any).waveform,
        json: serializableSnapshot(attachment)
      }
    }))
  });
}

export function channelRecordFromMessage(message: Message) {
  return channelRecordFromChannel(message.guildId!, message.channel as TextBasedChannel & GuildBasedChannel);
}

export function channelRecordFromChannel(guildId: string, channel: GuildBasedChannel | (TextBasedChannel & { id: string; type: number })) {
  return {
    id: channel.id,
    guildId,
    parentId: "parentId" in channel ? channel.parentId ?? null : null,
    name: "name" in channel ? channel.name ?? null : null,
    type: channel.type,
    isThread: Boolean(channel.isThread?.()),
    discordCreatedAt: dateFromDiscordValue((channel as any).createdAt ?? (channel as any).createdTimestamp),
    lastMessageId: (channel as any).lastMessageId ?? null,
    topic: (channel as any).topic ?? null,
    ownerId: (channel as any).ownerId ?? null,
    archived: typeof (channel as any).archived === "boolean" ? (channel as any).archived : null,
    archiveTimestamp: dateFromDiscordValue((channel as any).archiveTimestamp),
    raw: channelSnapshot(channel)
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

function channelSnapshot(channel: any) {
  return {
    id: channel.id,
    name: channel.name ?? null,
    type: channel.type,
    parentId: channel.parentId ?? null,
    createdTimestamp: channel.createdTimestamp ?? null,
    lastMessageId: channel.lastMessageId ?? null,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? null,
    position: channel.position ?? null,
    rateLimitPerUser: channel.rateLimitPerUser ?? null,
    ownerId: channel.ownerId ?? null,
    archived: channel.archived ?? null,
    archiveTimestamp: channel.archiveTimestamp ?? null,
    autoArchiveDuration: channel.autoArchiveDuration ?? null,
    locked: channel.locked ?? null,
    invitable: channel.invitable ?? null,
    flags: serializableSnapshot(channel.flags),
    json: serializableSnapshot(channel)
  };
}

function guildMemberSnapshot(member?: GuildMember | null) {
  if (!member) return null;
  return {
    id: member.id,
    displayName: member.displayName,
    nickname: member.nickname,
    joinedTimestamp: member.joinedTimestamp,
    premiumSinceTimestamp: member.premiumSinceTimestamp,
    roles: guildMemberRoleIds(member),
    avatar: member.avatar,
    pending: member.pending,
    communicationDisabledUntilTimestamp: member.communicationDisabledUntilTimestamp,
    flags: serializableSnapshot((member as any).flags),
    json: serializableSnapshot(member)
  };
}

function guildMemberRoleIds(member?: GuildMember | null) {
  if (!member) return [];
  return [...member.roles.cache.keys()].filter((roleId) => roleId !== member.guild.id);
}

function mentionSnapshot(message: Message) {
  const mentions = (message as any).mentions;
  return {
    everyone: Boolean(mentions?.everyone),
    users: [...(mentions?.users?.values?.() ?? [])].map(userSnapshot),
    roles: [...(mentions?.roles?.values?.() ?? [])].map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      position: role.position
    })),
    channels: [...(mentions?.channels?.values?.() ?? [])].map((channel) => ({
      id: channel.id,
      name: "name" in channel ? channel.name : null,
      type: channel.type
    }))
  };
}

function userSnapshot(user: any) {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName,
    bot: Boolean(user.bot),
    avatar: user.avatar,
    discriminator: user.discriminator,
    json: serializableSnapshot(user)
  };
}

function collectionSnapshots(values: any[] | undefined | null) {
  return (values ?? []).map(serializableSnapshot);
}

function serializableSnapshot(value: any): unknown {
  if (value == null) return null;
  if (typeof value.toJSON === "function") return value.toJSON();
  return value;
}

function dateFromDiscordValue(value: Date | number | null | undefined) {
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  return null;
}
