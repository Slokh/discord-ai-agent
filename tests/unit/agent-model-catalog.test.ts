import { describe, expect, it, vi } from "vitest";
import { resolveAgentModel } from "../../src/tools/agentModelCatalog.js";
import type { AppConfig } from "../../src/config/env.js";

const config = {
  openRouter: {
    chatModel: "moonshotai/kimi-k3",
    chatFallbackModel: "fallback/recovery",
  },
} as AppConfig;

describe("agent model catalog resolution", () => {
  it("resolves current catalog names and compact aliases", async () => {
    const openRouter = client([
      { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" },
      { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" },
      { id: "anthropic/claude-sonnet-5:batch", name: "Anthropic: Claude Sonnet 5" },
    ]);

    await expect(resolveAgentModel("Sonnet 5", { config, openRouter }))
      .resolves.toEqual({ ok: true, model: "anthropic/claude-sonnet-5" });
    await expect(resolveAgentModel("kimi k3", { config, openRouter }))
      .resolves.toEqual({ ok: true, model: "moonshotai/kimi-k3" });
  });

  it("requires exact IDs to exist in configuration or the live catalog", async () => {
    const openRouter = client([]);

    await expect(resolveAgentModel("unknown/not-real", { config, openRouter }))
      .resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("returns candidates instead of guessing across ambiguous aliases", async () => {
    const openRouter = client([
      { id: "one/nova", name: "Nova" },
      { id: "two/nova", name: "Nova" },
    ]);

    await expect(resolveAgentModel("nova", { config, openRouter }))
      .resolves.toEqual({
        ok: false,
        reason: "ambiguous",
        candidates: ["one/nova", "two/nova"],
      });
  });

  it("falls back only to configured models when the catalog is unavailable", async () => {
    const openRouter = {
      listModels: vi.fn(async () => {
        throw new Error("catalog unavailable");
      }),
    };

    await expect(resolveAgentModel("Kimi K3", { config, openRouter }))
      .resolves.toEqual({ ok: true, model: "moonshotai/kimi-k3" });
    await expect(resolveAgentModel("anthropic/claude-sonnet-5", { config, openRouter }))
      .resolves.toEqual({ ok: false, reason: "catalog_unavailable", candidates: undefined });
  });
});

function client(models: Array<{ id: string; name: string }>) {
  return { listModels: vi.fn(async () => models) };
}
