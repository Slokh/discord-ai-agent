export function embeddingPriorityForMessageTimestamp(
  createdTimestamp: number | Date | undefined | null,
) {
  const timestampMs = createdTimestamp instanceof Date
    ? createdTimestamp.getTime()
    : createdTimestamp;
  if (timestampMs == null || !Number.isFinite(timestampMs)) return 0;
  return normalizeEmbeddingPriority(Math.floor(timestampMs / 1000));
}

export function normalizeEmbeddingPriority(priority: number | undefined) {
  if (priority == null || !Number.isFinite(priority)) return 0;
  return Math.max(0, Math.min(2_147_483_647, Math.trunc(priority)));
}
