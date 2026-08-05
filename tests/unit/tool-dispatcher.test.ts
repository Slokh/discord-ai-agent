import { describe, expect, it, vi } from "vitest";
import { executeLocalToolRoute } from "../../src/agent/toolDispatcher.js";
import { loadConfig } from "../../src/config/env.js";
import { OpenRouterHttpError } from "../../src/models/openrouter.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("tool dispatcher failure boundary", () => {
  it("turns an unexpected non-mutating provider failure into a typed limitation", async () => {
    const ctx = context({
      auditTool: vi.fn(async () => undefined),
      chat: vi.fn(async () => {
        throw new OpenRouterHttpError({ status: 400, message: "private provider detail" });
      }),
    });

    await expect(executeLocalToolRoute(ctx, {
      id: "call-1",
      name: "inspectDiscordImages",
      arguments: {
        question: "What is shown?",
        imageUrls: ["https://example.com/image.png"],
        useContextImages: false,
      },
      argumentsText: JSON.stringify({
        question: "What is shown?",
        imageUrls: ["https://example.com/image.png"],
        useContextImages: false,
      }),
    }, "inspect this image")).resolves.toMatchObject({
      status: "error",
      errorCode: "tool_execution_failed",
      retryable: false,
      limitation: expect.stringContaining("failed before returning usable evidence"),
      content: expect.not.stringContaining("private provider detail"),
    });
  });

  it("does not contain mutating-tool exceptions", async () => {
    const failure = new Error("durable preference write failed");
    const ctx = context({
      auditTool: vi.fn(async () => undefined),
      clearUserPreference: vi.fn(async () => {
        throw failure;
      }),
      setUserPreference: vi.fn(async () => undefined),
    });
    ctx.mutationAuthorizedByCurrentInput = true;

    await expect(executeLocalToolRoute(ctx, {
      id: "call-2",
      name: "setMyTimezone",
      arguments: { action: "reset" },
      argumentsText: JSON.stringify({ action: "reset" }),
    }, "reset my timezone")).rejects.toBe(failure);
  });

  it("preserves request cancellation before a non-mutating tool executes", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));
    const chat = vi.fn();
    const ctx = context({ auditTool: vi.fn(async () => undefined), chat });
    ctx.abortSignal = controller.signal;

    await expect(executeLocalToolRoute(ctx, {
      id: "call-3",
      name: "inspectDiscordImages",
      arguments: { imageUrls: ["https://example.com/image.png"], useContextImages: false },
      argumentsText: JSON.stringify({ imageUrls: ["https://example.com/image.png"], useContextImages: false }),
    }, "inspect this image")).rejects.toThrow("request cancelled");
    expect(chat).not.toHaveBeenCalled();
  });
});

function context(input: Record<string, unknown>): ToolContext {
  const config = loadConfig();
  const { chat, ...repo } = input;
  return {
    config: {
      ...config,
      openRouter: { ...config.openRouter, apiKey: "test-key" },
    },
    repo: repo as ToolContext["repo"],
    openRouter: { chat } as ToolContext["openRouter"],
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    userDisplayName: "Kartik",
    visibleChannelIds: ["channel-1"],
    requestAttachments: [],
    mutationAuthorizedByCurrentInput: false,
  } as ToolContext;
}
