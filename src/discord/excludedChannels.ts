export const EXCLUDED_CHANNEL_IDS: readonly string[] = ["1172353113471074314"];

const EXCLUDED_CHANNEL_ID_SET = new Set(EXCLUDED_CHANNEL_IDS);

export function isExcludedChannelId(channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  return EXCLUDED_CHANNEL_ID_SET.has(channelId);
}

export function filterExcludedChannelIds(channelIds: readonly string[]): string[] {
  return channelIds.filter((channelId) => !EXCLUDED_CHANNEL_ID_SET.has(channelId));
}
