import { describe, expect, it } from "vitest";
import { nanoCodexEstimatedCostUsd, normalizeNanoCodexUsage } from "../../src/agent/nanocodexUsage.js";

describe("NanoCodex usage normalization", () => {
  it("maps aggregate turn usage and exact string costs into canonical telemetry", () => {
    const raw = {
      input_tokens: 100,
      cached_input_tokens: 60,
      cache_write_input_tokens: 10,
      output_tokens: 20,
      reasoning_output_tokens: 15,
      total_tokens: 120,
      estimated_cost: { usd: "0.001234567", service_tier: "standard" },
    };
    expect(normalizeNanoCodexUsage(raw)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 15,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 10,
    });
    expect(nanoCodexEstimatedCostUsd(raw)).toBe(0.001234567);
  });

  it("maps provider response usage details", () => {
    expect(normalizeNanoCodexUsage({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 13,
    })).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13, reasoningTokens: 2, cachedInputTokens: 4, cacheWriteInputTokens: 2 });
  });
});
