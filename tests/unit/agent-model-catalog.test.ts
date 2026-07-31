import { describe, expect, it, vi } from "vitest";
import { resolveAgentModel } from "../../src/tools/agentModelCatalog.js";
import type { AppConfig } from "../../src/config/env.js";

const config = { openRouter: { chatModel: "openai/gpt-5.6-sol" } } as unknown as AppConfig;
const openRouter = { listModels: vi.fn(async () => []) };

describe("NanoCodex model resolution", () => {
  it("resolves Sol and Luna aliases without consulting a provider catalog", async () => {
    await expect(resolveAgentModel("Sol", { config, openRouter }))
      .resolves.toEqual({ ok: true, model: "openai/gpt-5.6-sol" });
    await expect(resolveAgentModel("gpt 5.6 luna", { config, openRouter }))
      .resolves.toEqual({ ok: true, model: "openai/gpt-5.6-luna" });
    expect(openRouter.listModels).not.toHaveBeenCalled();
  });

  it("accepts exact NanoCodex model IDs", async () => {
    await expect(resolveAgentModel("openai/gpt-5.6-sol", { config, openRouter }))
      .resolves.toEqual({ ok: true, model: "openai/gpt-5.6-sol" });
  });

  it("rejects models outside the NanoCodex foundation", async () => {
    await expect(resolveAgentModel("anthropic/claude-sonnet-5", { config, openRouter }))
      .resolves.toEqual({ ok: false, reason: "not_found" });
  });
});
