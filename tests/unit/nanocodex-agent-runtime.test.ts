import { describe, expect, it, vi } from "vitest";
import { compactNanoCodexToolDefinitions, executeNanoCodexAgentRuntime } from "../../src/agent/nanocodexAgentRuntime.js";
import { loadConfig } from "../../src/config/env.js";
import { localToolDefinitionsForModel } from "../../src/tools/registry.js";

describe("NanoCodex agent runtime executor", () => {
  it("keeps the full tool contract while bounding model-facing descriptions", () => {
    const original = localToolDefinitionsForModel();
    const compact = compactNanoCodexToolDefinitions(original);
    expect(compact.map((tool) => tool.function.name)).toEqual(original.map((tool) => tool.function.name));
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length * 0.75);
    expect(Math.max(...compact.map((tool) => tool.function.description?.length ?? 0))).toBeLessThanOrEqual(600);
  });

  it("runs a retained NanoCodex turn with the full deployment-safe tool contract", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      expect(input.model).toBe("openai/gpt-5.6-luna");
      expect(input.thinking).toBe("high");
      expect(input.sessionId).toMatch(/^[0-9a-f-]+$/);
      expect(input.sessionId).not.toBe("018f1f9a-7b3c-7a01-8000-000000000001");
      expect(input.hostedWebSearch).toBe(true);
      expect(input.instructions).not.toContain("Current Discord requester: Kartik");
      expect(input.prompt).toContain("Current Discord requester: Kartik");
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

  it("starts fresh from legacy checkpoints whose resume contract is unavailable", async () => {
    const runtime = agentRuntime();
    runtime.getLatestBinaryArtifactForSession.mockResolvedValue({
      artifact: {} as never,
      data: Buffer.from(JSON.stringify(snapshot()), "utf8"),
    });
    const runRuntime = vi.fn(async (input: any) => {
      expect(input.resume).toBeUndefined();
      expect(input.prompt).toContain("USER: User: old request");
      expect(input.prompt).toContain("USER: current request");
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

  it("resumes a realistic follow-up when only per-turn Discord context changed", async () => {
    const runtime = agentRuntime();
    let firstInstructions = "";
    const firstRun = vi.fn(async (input: any) => {
      firstInstructions = input.instructions;
      expect(input.resume).toBeUndefined();
      return result("first answer");
    });
    const firstContext = toolContext(runtime);
    firstContext.sessionMessages = [{ role: "user", content: "first request", authorDisplayName: "Kartik", metadata: {} } as never];
    await executeNanoCodexAgentRuntime({
      toolContext: firstContext,
      text: "first request",
      timeoutMs: 1_000,
      runRuntime: firstRun as never,
    });

    const stored = (runtime.storeBinaryArtifact.mock.calls as any[]).at(-1)?.[0] as any;
    runtime.getLatestBinaryArtifactForSession.mockResolvedValue({
      artifact: { metadata: stored.metadata } as never,
      metadata: stored.metadata,
      data: Buffer.from(JSON.stringify(snapshot()), "utf8"),
    } as never);
    const secondRun = vi.fn(async (input: any) => {
      expect(input.resume).toEqual(snapshot());
      expect(input.instructions).toBe(firstInstructions);
      expect(input.instructions).not.toContain("first answer");
      expect(input.prompt).toContain("first answer");
      expect(input.prompt).toContain("USER: second request");
      expect(input.prompt).not.toContain("USER: Kartik: first request");
      return result("second answer");
    });
    const secondContext = toolContext(runtime);
    secondContext.requestId = "request-2";
    secondContext.requestMessageId = "request-2";
    secondContext.agentRuntimeExecutionId = "execution-2";
    secondContext.sessionMessages = [
      { role: "user", content: "first request", authorDisplayName: "Kartik", metadata: {} },
      { role: "assistant", content: "first answer", metadata: {} },
    ] as never;
    secondContext.replyContext = {
      rootMessageId: "root-1",
      messageId: "parent-1",
      chain: [{
        messageId: "parent-1",
        content: "first answer",
        authorId: "bot-1",
        authorDisplayName: "Bot",
        attachmentSummaries: [],
        reactionSummaries: [],
        attachments: [],
      }],
    } as never;
    await executeNanoCodexAgentRuntime({
      toolContext: secondContext,
      text: "second request",
      timeoutMs: 1_000,
      runRuntime: secondRun as never,
    });
  });

  it("returns a successful mutating tool result when NanoCodex exits before its final message", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      const result = await input.executeTool({ callId: "call-1", name: "drawRandom", arguments: { kind: "coin", count: 1, reason: "coin flip" } });
      expect(result.success).toBe(true);
      throw new Error("runtime exited before completion");
    });
    const ctx = toolContext(runtime);
    const executeToolRoute = vi.fn(async () => ({
      content: "Provably fair draw complete. Coin: heads.",
      status: "ok" as const,
      footerLines: ["RNG proof: verified"],
      outcome: { kind: "rng_draw", state: "succeeded" as const, terminal: true },
    }));

    await expect(executeNanoCodexAgentRuntime({
      toolContext: ctx,
      text: "flip a coin",
      timeoutMs: 1_000,
      runRuntime: runRuntime as never,
      executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({
      content: expect.stringContaining("Provably fair draw complete"),
    });
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.post_mutation_recovered",
    }));
  });
});

function toolContext(runtime: ReturnType<typeof agentRuntime>) {
  const config = loadConfig();
  return {
    config: {
      ...config,
      openRouter: {
        ...config.openRouter,
        apiKey: "test-key",
        chatModel: "openai/gpt-5.6-luna",
      },
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
