export type OpenRouterTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export function extractEstimatedCostUsd(json: any): number | undefined {
  const usage = json?.usage;
  const rawCost =
    usage?.cost ??
    usage?.total_cost ??
    usage?.cost_usd ??
    usage?.total_cost_usd;
  const cost = typeof rawCost === "string" ? Number(rawCost) : rawCost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

export function extractTokenUsage(
  json: any,
): OpenRouterTokenUsage | undefined {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const normalized: OpenRouterTokenUsage = {
    inputTokens: firstNumber(
      usage.prompt_tokens,
      usage.input_tokens,
      usage.inputTokens,
    ),
    outputTokens: firstNumber(
      usage.completion_tokens,
      usage.output_tokens,
      usage.outputTokens,
    ),
    totalTokens: firstNumber(usage.total_tokens, usage.totalTokens),
    reasoningTokens: firstNumber(
      usage.reasoning_tokens,
      usage.reasoningTokens,
      usage.completion_tokens_details?.reasoning_tokens,
      usage.output_tokens_details?.reasoning_tokens,
    ),
    cachedInputTokens: firstNumber(
      usage.cached_tokens,
      usage.cached_input_tokens,
      usage.cachedInputTokens,
      usage.prompt_tokens_details?.cached_tokens,
      usage.input_tokens_details?.cached_tokens,
      usage.cache_read_input_tokens,
    ),
  };
  const compact = Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value != null),
  ) as OpenRouterTokenUsage;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
