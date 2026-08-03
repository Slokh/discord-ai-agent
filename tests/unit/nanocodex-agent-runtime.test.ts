import { describe, expect, it, vi } from "vitest";
import { executeNanoCodexAgentRuntime } from "../../src/agent/nanocodexAgentRuntime.js";
import { loadConfig } from "../../src/config/env.js";
import { localToolDefinitionsForModel } from "../../src/tools/registry.js";

describe("NanoCodex agent runtime executor", () => {
  it("keeps the canonical nested tool contract visible to the model", () => {
    const definitions = localToolDefinitionsForModel();
    const presentation = definitions.find((tool) => tool.function.name === "composeDiscordResponse");
    expect(JSON.stringify(presentation?.function.parameters)).toContain('"media_gallery"');
    expect(presentation?.function.parameters).toBe(
      localToolDefinitionsForModel().find((tool) => tool.function.name === "composeDiscordResponse")?.function.parameters,
    );
  });

  it("runs a retained NanoCodex turn with the full deployment-safe tool contract", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      expect(input.model).toBe("openai/gpt-5.6-luna");
      expect(input.thinking).toBe("high");
      expect(input.sessionId).toMatch(/^[0-9a-f-]+$/);
      expect(input.sessionId).not.toBe("018f1f9a-7b3c-7a01-8000-000000000001");
      expect(input.hostedWebSearch).toBe(false);
      expect(input.instructions).not.toContain("Current Discord requester: Kartik");
      expect(input.prompt).toContain("Current Discord requester: Kartik");
      expect(input.prompt).toContain("Current NanoCodex model for this turn: `openai/gpt-5.6-luna`");
      expect(input.prompt).toContain("USER: hello");
      expect(input.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["loadSkillContext", "drawRandom", "researchWeb"]));
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

  it("retains an earlier committed result when a later mutation fails", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      expect((await input.executeTool({ callId: "call-1", name: "drawRandom", arguments: { kind: "coin" } })).success).toBe(true);
      expect((await input.executeTool({ callId: "call-2", name: "createDiscordPoll", arguments: { question: "Pick", answers: ["A", "B"] } })).success).toBe(false);
      throw new Error("runtime exited after the second tool");
    });
    const executeToolRoute = vi.fn(async (_ctx, route) => route.name === "drawRandom"
      ? { content: "Coin: heads", status: "ok" as const, outcome: { kind: "rng_draw", state: "succeeded" as const, terminal: true } }
      : { content: "Poll failed", status: "error" as const, outcome: { kind: "discord_poll", state: "failed" as const, terminal: false } });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "flip then poll",
      timeoutMs: 1_000,
      runRuntime: runRuntime as never,
      executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({ content: "Coin: heads" });
  });

  it("returns every committed mutation when NanoCodex exits before its final message", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      await input.executeTool({ callId: "call-1", name: "addDiscordReaction", arguments: { emoji: "👍" } });
      await input.executeTool({ callId: "call-2", name: "createDiscordPoll", arguments: { question: "Pick", answers: ["A", "B"] } });
      throw new Error("runtime exited after both writes");
    });
    const executeToolRoute = vi.fn(async (_ctx, route) => ({
      content: route.name === "addDiscordReaction" ? "Added 👍." : "Posted the poll.",
      status: "ok" as const,
      outcome: { kind: route.name, state: "succeeded" as const, terminal: true },
    }));

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime), text: "react and poll", timeoutMs: 1_000,
      runRuntime: runRuntime as never, executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({
      content: "Added 👍.\n\nPosted the poll.",
      outcome: { kind: "mutation_batch", state: "succeeded" },
    });
  });

  it("delivers a generated image when NanoCodex exits before its final message", async () => {
    const runtime = agentRuntime();
    const image = { name: "generated.png", contentType: "image/png", data: Buffer.from("image") };
    const runRuntime = vi.fn(async (input: any) => {
      const result = await input.executeTool({ callId: "call-1", name: "generateImage", arguments: { prompt: "a gnome" } });
      expect(result.success).toBe(true);
      throw new Error("runtime exited before completion");
    });
    const executeToolRoute = vi.fn(async () => ({
      content: "Generated image for: a gnome",
      files: [image],
    }));

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "generate an image of a gnome",
      timeoutMs: 1_000,
      runRuntime: runRuntime as never,
      executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({
      content: "Generated image for: a gnome",
      files: [expect.objectContaining({ name: "generated.png", data: image.data })],
    });
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.post_tool_output_recovered",
    }));
  });

  it("delivers generated files when the hard timeout wins the runtime race", async () => {
    const runtime = agentRuntime();
    const image = { name: "generated.png", contentType: "image/png", data: Buffer.from("image") };
    const runRuntime = vi.fn(async (input: any) => {
      await input.executeTool({ callId: "call-1", name: "generateImage", arguments: { prompt: "a gnome" } });
      await new Promise((_, reject) => input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason)));
      return result("unreachable");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "generate an image of a gnome",
      // Leave enough time for prompt/session setup on slower CI runners while
      // still forcing the hard timeout after the mocked tool has produced its file.
      timeoutMs: 250,
      runRuntime: runRuntime as never,
      executeToolRoute: (async () => ({ content: "Generated image for: a gnome", files: [image] })) as never,
    })).resolves.toMatchObject({
      content: "Done — the generated file is attached.",
      status: "partial",
      files: [expect.objectContaining({ name: "generated.png", data: image.data })],
    });
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.timeout_output_recovered",
    }));
  });

  it("delivers a completed mutation when the hard timeout wins the runtime race", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      await input.executeTool({ callId: "call-1", name: "addDiscordReaction", arguments: { emoji: "👍" } });
      await new Promise((_, reject) => input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason)));
      return result("unreachable");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "add the reaction",
      timeoutMs: 250,
      runRuntime: runRuntime as never,
      executeToolRoute: (async () => ({
        content: "Added 👍 to the Discord message.",
        status: "ok" as const,
        outcome: { kind: "discord_reaction", state: "succeeded" as const, terminal: true },
      })) as never,
    })).resolves.toMatchObject({
      content: "Added 👍 to the Discord message.",
      outcome: { state: "succeeded" },
    });
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.timeout_mutation_recovered",
    }));
  });

  it("does not bypass wager resolution when a timeout follows file generation", async () => {
    const runtime = agentRuntime();
    const image = { name: "generated.png", contentType: "image/png", data: Buffer.from("image") };
    const runRuntime = vi.fn(async (input: any) => {
      await input.executeTool({ callId: "call-1", name: "generateImage", arguments: { prompt: "a coin" } });
      await input.executeTool({ callId: "call-2", name: "drawRandom", arguments: { kind: "coin" } });
      await new Promise((_, reject) => input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason)));
      return result("unreachable");
    });
    const executeToolRoute = vi.fn(async (_ctx, route) => route.name === "generateImage"
      ? { content: "Generated image", files: [image] }
      : { content: "Coin: heads", status: "ok" as const, outcome: { kind: "rng_draw", state: "succeeded" as const, wagerActive: true } });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime), text: "make a wager", timeoutMs: 250,
      runRuntime: runRuntime as never, executeToolRoute: executeToolRoute as never,
    })).rejects.toThrow(/timed out/i);
    expect(runtime.recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.timeout_output_recovered",
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
