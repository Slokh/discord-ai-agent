/**
 * Hard, code-level blocklist of Discord channel IDs that must never surface
 * through any retrieval, search, stats, summary, topic, attachment, or
 * message-context query.
 *
 * This is intentionally separate from the per-guild `channels.is_excluded`
 * flag so it is enforced unconditionally at the query/database layer regardless
 * of how the caller assembled its `visibleChannelIds` list. It acts as a
 * defense-in-depth guard against the model or any caller bypassing the
 * permission/indexing filters.
 *
 * Adding a channel here means its messages cannot be returned by any read path
 * in `src/db/repositories.ts`.
 */
export const HARD_EXCLUDED_CHANNEL_IDS: ReadonlySet<string> = new Set([
  // #trivia-sucks
  "1172353113471074314"
]);

export function isHardExcludedChannel(channelId: string | null | undefined): boolean {
  return Boolean(channelId) && HARD_EXCLUDED_CHANNEL_IDS.has(String(channelId));
}

export function withoutHardExcludedChannels(channelIds: ReadonlyArray<string>): string[] {
  return channelIds.filter((id) => !isHardExcludedChannel(id));
}
