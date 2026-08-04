export type NormalizedNanoCodexUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export function normalizeNanoCodexUsage(value: unknown): NormalizedNanoCodexUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputDetails = record(usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details);
  const normalized: NormalizedNanoCodexUsage = compact({
    inputTokens: nonnegativeNumber(usage.input_tokens),
    outputTokens: nonnegativeNumber(usage.output_tokens),
    totalTokens: nonnegativeNumber(usage.total_tokens),
    reasoningTokens: nonnegativeNumber(usage.reasoning_output_tokens ?? outputDetails?.reasoning_tokens),
    cachedInputTokens: nonnegativeNumber(usage.cached_input_tokens ?? inputDetails?.cached_tokens),
    cacheWriteInputTokens: nonnegativeNumber(usage.cache_write_input_tokens ?? inputDetails?.cache_write_tokens),
  });
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function nanoCodexEstimatedCostUsd(value: unknown): number | undefined {
  const usage = record(value);
  const direct = nonnegativeNumber(usage?.cost_usd);
  if (direct !== undefined) return direct;
  const cost = record(usage?.estimated_cost);
  return nonnegativeNumber(cost?.usd);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function compact<T extends Record<string, number | undefined>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => entry[1] !== undefined)) as Partial<T>;
}
