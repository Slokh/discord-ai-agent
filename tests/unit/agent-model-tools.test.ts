import { describe, expect, it, vi } from "vitest";
import { primaryChatPolicy, recoveryChatPolicy } from "../../src/agent/modelPolicy.js";
import {
  effectiveAgentChatModel,
  loadAgentModelOverride,
  normalizeOpenRouterModelId,
  setAgentModel,
} from "../../src/tools/agentModelTools.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("agent model settings", () => {
  it("validates OpenRouter model IDs locally", () => {
    expect(normalizeOpenRouterModelId(" moonshotai/kimi-k3 ")).toBe("moonshotai/kimi-k3");
    expect(normalizeOpenRouterModelId("openai/gpt-5.6:online")).toBe("openai/gpt-5.6:online");
    expect(normalizeOpenRouterModelId("not-a-model")).toBeNull();
    expect(normalizeOpenRouterModelId("provider/model with spaces")).toBeNull();
  });

  it("loads the durable override once and applies it only to primary chat", async () => {
    const getGuildAgentSettings = vi.fn(async () => ({ chatModel: "moonshotai/kimi-k3" }));
    const ctx = context("owner", { getGuildAgentSettings });

    await loadAgentModelOverride(ctx);
    await loadAgentModelOverride(ctx);

    expect(getGuildAgentSettings).toHaveBeenCalledTimes(1);
    expect(effectiveAgentChatModel(ctx)).toBe("moonshotai/kimi-k3");
    expect(primaryChatPolicy(ctx).model).toBe("moonshotai/kimi-k3");
    expect(recoveryChatPolicy(ctx).model).toBe("fallback/recovery");
  });

  it("sets and resets the server override for configured owners and ops", async () => {
    const repo = settingsRepo();
    const ownerCtx = context("owner", repo);
    ownerCtx.requestText = "switch to Sonnet 5";

    await expect(setAgentModel(ownerCtx, {
      action: "set",
      model: "Sonnet 5",
    })).resolves.toContain("Switched this server's primary chat model");
    expect(repo.setGuildChatModelOverride).toHaveBeenCalledWith({
      guildId: "guild",
      chatModel: "anthropic/claude-sonnet-5",
      updatedByUserId: "owner",
    });
    expect(effectiveAgentChatModel(ownerCtx)).toBe("anthropic/claude-sonnet-5");

    const opsCtx = context("operator", repo);
    opsCtx.chatModelOverride = "bad-provider/missing-model";
    opsCtx.chatModelOverrideLoaded = true;
    opsCtx.requestText = "reset model";
    await expect(setAgentModel(opsCtx, { action: "reset" }))
      .resolves.toContain("configured default");
    expect(repo.clearGuildChatModelOverride).toHaveBeenCalledWith("guild");
    expect(effectiveAgentChatModel(opsCtx)).toBe("configured/default");
  });

  it("denies unconfigured users and leaves durable state unchanged", async () => {
    const repo = settingsRepo();
    const ctx = context("friend", repo);
    ctx.requestText = "switch to Kimi K3";

    await expect(setAgentModel(ctx, {
      action: "set",
      model: "moonshotai/kimi-k3",
    })).resolves.toContain("restricted");
    expect(repo.setGuildChatModelOverride).not.toHaveBeenCalled();
    expect(repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "setAgentModel",
      error: "agent_model_admin_required",
    }));
  });

  it("audits invalid model IDs without changing durable state", async () => {
    const repo = settingsRepo();
    const ctx = context("owner", repo);
    ctx.requestText = "switch model to not-a-model";

    await expect(setAgentModel(ctx, {
      action: "set",
      model: "not-a-model",
    })).resolves.toContain("couldn’t find");
    expect(repo.setGuildChatModelOverride).not.toHaveBeenCalled();
    expect(repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "setAgentModel",
      error: "agent_model_not_found",
    }));
  });

  it("requires explicit current-turn mutation intent even when the model calls the tool", async () => {
    const repo = settingsRepo();
    const ctx = context("owner", repo);
    ctx.requestText = "I literally added a tool for you to change models";

    await expect(setAgentModel(ctx, {
      action: "set",
      model: "moonshotai/kimi-k3",
    })).resolves.toContain("does not explicitly ask");
    expect(repo.setGuildChatModelOverride).not.toHaveBeenCalled();
    expect(repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      error: "agent_model_current_intent_required",
    }));
  });

  it("rejects a model-generated target that conflicts with the current request", async () => {
    const repo = settingsRepo();
    const ctx = context("owner", repo);
    ctx.requestText = "switch back to Kimi K3";

    await expect(setAgentModel(ctx, {
      action: "set",
      model: "moonshotai/kimi-k2",
    })).resolves.toContain("current message authorizes");
    expect(repo.setGuildChatModelOverride).not.toHaveBeenCalled();
    expect(repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      error: "agent_model_intent_mismatch",
    }));
  });
});

function settingsRepo() {
  return {
    getGuildAgentSettings: vi.fn(async () => undefined),
    setGuildChatModelOverride: vi.fn(async () => undefined),
    clearGuildChatModelOverride: vi.fn(async () => true),
    auditTool: vi.fn(async () => undefined),
    recordTraceEvent: vi.fn(async () => undefined),
  };
}

function context(userId: string, repo: Record<string, unknown>): ToolContext {
  return {
    config: {
      maxReplyChars: 1_800,
      openRouter: {
        chatModel: "configured/default",
        chatFallbackModel: "fallback/recovery",
      },
      allowlists: {
        ownerUserId: "owner",
        opsUserIds: ["operator"],
      },
    },
    repo,
    openRouter: {
      listModels: vi.fn(async () => [
        { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" },
        { id: "moonshotai/kimi-k2", name: "MoonshotAI: Kimi K2" },
        { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" },
      ]),
    },
    guildId: "guild",
    channelId: "channel",
    userId,
    userDisplayName: userId,
    visibleChannelIds: ["channel"],
    requestId: "request",
  } as unknown as ToolContext;
}
