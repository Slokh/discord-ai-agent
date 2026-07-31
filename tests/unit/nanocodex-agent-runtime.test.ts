import { describe, expect, it, vi } from "vitest";
import { executeNanoCodexAgentRuntime } from "../../src/agent/nanocodexAgentRuntime.js";
import { loadConfig } from "../../src/config/env.js";

describe("NanoCodex agent runtime executor", () => {
  it("runs a retained NanoCodex turn with the full deployment-safe tool contract", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      expect(input.model).toBe("openai/gpt-5.6-luna");
      expect(input.thinking).toBe("high");
      expect(input.sessionId).toMatch(/^[0-9a-f-]+$/);
      expect(input.sessionId).not.toBe("018f1f9a-7b3c-7a01-8000-000000000001");
      expect(input.hostedWebSearch).toBe(true);
      expect(input.instructions).toContain("Current Discord requester: Kartik");
      expect(input.prompt).toContain("USER: hello");
      expect(input.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["listTools", "drawRandom"]));
      await expect(input.executeTool({ callId: "bad-1", name: "notRegistered", arguments: {} })).resolves.toEqual({
        success: false,
        output: "Tool notRegistered is not available for this request.",
      });
      return result("hello from NanoCodex");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "hello",
      timeoutMs: 1_000,
      runRuntime: runRuntime as never,
    })).resolves.toMatchObject({ content: "hello from NanoCodex" });

    expect(runtime.storeBinaryArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: "nanocodex_session_snapshot",
      sessionId: "018f1f9a-7b3c-7a01-8000-000000000001",
      executionId: "execution-1",
    }));
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.complete",
    }));
  });

  it("resumes from the latest canonical NanoCodex snapshot without replaying old chat", async () => {
    const runtime = agentRuntime();
    runtime.getLatestBinaryArtifactForSession.mockResolvedValue({
      artifact: {} as never,
      data: Buffer.from(JSON.stringify(snapshot()), "utf8"),
    });
    const runRuntime = vi.fn(async (input: any) => {
      expect(input.resume).toEqual(snapshot());
      expect(input.prompt).toBe("USER: current request");
      return result("resumed");
    });

    const ctx = toolContext(runtime);
    ctx.sessionMessages = [{ role: "user", content: "old request" } as never];
    await executeNanoCodexAgentRuntime({
      toolContext: ctx,
      text: "current request",
      timeoutMs: 1_000,
      runRuntime: runRuntime as never,
    });
  });
});

function toolContext(runtime: ReturnType<typeof agentRuntime>) {
  const config = loadConfig();
  return {
    config: {
      ...config,
      openRouter: { ...config.openRouter, chatModel: "openai/gpt-5.6-luna" },
    },
    repo: {},
    agentRuntime: runtime,
    agentRuntimeSession: {
      sessionId: "018f1f9a-7b3c-7a01-8000-000000000001",
      traceId: "request-1",
    },
    agentRuntimeExecutionId: "execution-1",
    openRouter: {},
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    userDisplayName: "Kartik",
    visibleChannelIds: ["channel-1"],
    requestId: "request-1",
    requestMessageId: "request-1",
    requestAttachments: [],
    discordGuildEmojis: [],
  } as any;
}

function agentRuntime() {
  return {
    getLatestBinaryArtifactForSession: vi.fn(async () => undefined as any),
    storeBinaryArtifact: vi.fn(async () => ({} as any)),
    recordEvent: vi.fn(async () => ({} as any)),
    appendMessage: vi.fn(async () => ({} as any)),
  };
}

function snapshot() {
  return {
    version: 1,
    model: "gpt-5.6-sol",
    lineage_id: "lineage-1",
    prompt_cache_key: "cache-1",
    workspace: "/workspace",
    canonical_context: {},
    history: [],
  };
}

function result(finalMessage: string) {
  return { finalMessage, usage: { total_tokens: 12 }, snapshot: snapshot() };
}
