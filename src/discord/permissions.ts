import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  PermissionsBitField,
  type TextBasedChannel
} from "discord.js";

const readableTypes = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
]);

export function canMemberReadChannel(member: GuildMember, channel: { permissionsFor?: (member: GuildMember) => any }) {
  const permissions = channel.permissionsFor?.(member);
  return Boolean(
    permissions?.has(PermissionsBitField.Flags.ViewChannel) &&
      permissions?.has(PermissionsBitField.Flags.ReadMessageHistory)
  );
}

export async function visibleChannelIdsForMember(
  guild: Guild,
  member: GuildMember,
  extraChannelIds: string[] = []
): Promise<string[]> {
  await guild.channels.fetch();
  const visible = new Set<string>();

  for (const channel of guild.channels.cache.values()) {
    if (!channel || !readableTypes.has(channel.type)) continue;
    if (canMemberReadChannel(member, channel)) visible.add(channel.id);
  }

  for (const channelId of [...new Set(extraChannelIds)].filter(Boolean)) {
    const channel = await fetchGuildChannelById(guild, channelId);
    if (!channel || !readableTypes.has(channel.type)) continue;
    if (canMemberReadChannel(member, channel)) visible.add(channel.id);
  }

  return [...visible];
}

async function fetchGuildChannelById(guild: Guild, channelId: string) {
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  return guild.channels.fetch(channelId).catch(() => null);
}

export function isMessageReadableChannel(channel: GuildBasedChannel | TextBasedChannel | null | undefined): boolean {
  if (!channel || !("type" in channel)) return false;
  return readableTypes.has(channel.type);
}

type PermissionLike = {
  has: (permission: bigint) => boolean;
};

type PermissionSummaryChannel = {
  id: string;
  name?: string | null;
  type: number;
  permissionsFor?: (member: GuildMember) => PermissionLike | null | undefined;
};

export type BotChannelPermissionSummary = {
  hasAdministrator: boolean;
  textLikeChannels: number;
  crawlableChannels: number;
  sendableChannels: number;
  threadSendableChannels: number;
  attachableChannels: number;
  missingCrawlChannelNames: string[];
  missingSendChannelNames: string[];
  missingAttachChannelNames: string[];
};

export function validateMemberLevelBotPermissions(
  summary: Pick<
    BotChannelPermissionSummary,
    "hasAdministrator" | "textLikeChannels" | "crawlableChannels" | "sendableChannels" | "threadSendableChannels" | "attachableChannels"
  >
): string[] {
  const errors: string[] = [];
  if (summary.hasAdministrator) {
    errors.push("Bot has Administrator permission; re-invite or update the server role so Discord AI Agent runs with member-level access.");
  }
  if (summary.textLikeChannels === 0) {
    errors.push("Bot cannot see any text, announcement, thread, forum, or media channels in the configured guild.");
  }
  if (summary.crawlableChannels === 0) {
    errors.push("Bot cannot crawl any text-like channels; grant View Channel and Read Message History in at least one channel.");
  }
  if (summary.sendableChannels === 0) {
    errors.push("Bot cannot send messages in any text-like channels; grant Send Messages in at least one channel.");
  }
  if (summary.threadSendableChannels === 0) {
    errors.push("Bot cannot send messages in threads anywhere; grant Send Messages in Threads for thread acceptance checks.");
  }
  if (summary.attachableChannels === 0) {
    errors.push("Bot cannot attach files anywhere; grant Attach Files for image generation acceptance checks.");
  }
  return errors;
}

export function summarizeBotChannelPermissions(
  member: GuildMember,
  channels: Iterable<PermissionSummaryChannel | null | undefined>,
  sampleLimit = 10
): BotChannelPermissionSummary {
  const summary: BotChannelPermissionSummary = {
    hasAdministrator: hasPermission((member as { permissions?: PermissionLike }).permissions, PermissionsBitField.Flags.Administrator),
    textLikeChannels: 0,
    crawlableChannels: 0,
    sendableChannels: 0,
    threadSendableChannels: 0,
    attachableChannels: 0,
    missingCrawlChannelNames: [],
    missingSendChannelNames: [],
    missingAttachChannelNames: []
  };

  for (const channel of channels) {
    if (!channel || !readableTypes.has(channel.type)) continue;
    summary.textLikeChannels += 1;

    const permissions = channel.permissionsFor?.(member);
    const canView = hasPermission(permissions, PermissionsBitField.Flags.ViewChannel);
    const canReadHistory = hasPermission(permissions, PermissionsBitField.Flags.ReadMessageHistory);
    const canSend = hasPermission(permissions, PermissionsBitField.Flags.SendMessages);
    const canSendThreads = hasPermission(permissions, PermissionsBitField.Flags.SendMessagesInThreads);
    const canAttach = hasPermission(permissions, PermissionsBitField.Flags.AttachFiles);
    const label = channelLabel(channel);

    if (canView && canReadHistory) summary.crawlableChannels += 1;
    else pushSample(summary.missingCrawlChannelNames, label, sampleLimit);

    if (canView && canSend) summary.sendableChannels += 1;
    else pushSample(summary.missingSendChannelNames, label, sampleLimit);

    if (canView && canSendThreads) summary.threadSendableChannels += 1;

    if (canView && canAttach) summary.attachableChannels += 1;
    else pushSample(summary.missingAttachChannelNames, label, sampleLimit);
  }

  return summary;
}

function hasPermission(permissions: PermissionLike | null | undefined, flag: bigint) {
  return Boolean(permissions?.has(flag));
}

function channelLabel(channel: PermissionSummaryChannel) {
  return channel.name ? `#${channel.name} (${channel.id})` : channel.id;
}

function pushSample(items: string[], value: string, limit: number) {
  if (items.length < limit) items.push(value);
}
