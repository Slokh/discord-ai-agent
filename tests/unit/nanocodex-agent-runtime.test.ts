import { describe, expect, it, vi } from "vitest";
import { buildSessionPrompt, executeNanoCodexAgentRuntime, sessionKeyFor, steerActiveTurn } from "../../src/agent/nanocodexAgentRuntime.js";
import { nanocodeSessionId, type NanocodeHostClient } from "../../src/agent/nanocodeHost.js";
import { sessionToolDefinitions } from "../../src/agent/sharedNanocodeHost.js";
import { loadConfig } from "../../src/config/env.js";
import { OpenRouterHttpError } from "../../src/models/openrouter.js";
import { localToolDefinitionsForModel } from "../../src/tools/registry.js";

describe("NanoCodex agent runtime executor", () => {
  it("runs a session turn with stable instructions and an attributed message", async () => {
    const runtime = agentRuntime();
    const runTurn = vi.fn(async (input: any) => {
      expect(input.model).toBe("gpt-6-luna");
      expect(input.thinking).toBe("high");
      expect(input.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(input.requestId).toBe("request-1");
      expect(input.instructions).not.toContain("Current Discord requester: Kartik");
      expect(input.instructions).toContain("<message from=");
      expect(input.prompt.text).toContain("Current Discord requester: Kartik");
      expect(input.prompt.text).toContain('<message from="Kartik" user_id="user-1">\nhello\n</message>');
      expect(input.prompt.images).toEqual([]);
      expect(input.bootstrap).toBeUndefined();
      await expect(input.executeTool({ callId: "bad-1", name: "notRegistered", arguments: {} })).resolves.toEqual({
        success: false,
        output: "Tool notRegistered is not available for this request.",
      });
      await input.onEvent({
        type: "tool.call",
        seq: 7,
        payload: { tool: "exec", call_id: "call-1", arguments: "sensitive arguments are not retained", model_call_index: 1 },
      });
      return result("hello from nanocode");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "hello",
      timeoutMs: 1_000,
      host: fakeHost(runTurn),
    })).resolves.toMatchObject({ content: "hello from nanocode" });

    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "agent.nanocodex.complete" }));
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.tool.call",
      summary: "nanocode tool.call: exec",
      metadata: expect.objectContaining({ toolName: "exec", callId: "call-1", nanoSequence: 7 }),
    }));
    expect(runtime.recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ arguments: expect.anything() }),
    }));
  });

  it("gives the session the deployment's full tool catalog", () => {
    const names = sessionToolDefinitions(localToolDefinitionsForModel()).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["loadSkillContext", "drawRandom", "web__run"]));
    const images = sessionToolDefinitions(localToolDefinitionsForModel()).find((tool) => tool.name === "inspectDiscordImages");
    expect(images?.description).toContain("pass its direct text result to text(...); do not read .content or repeat the call");
  });

  it("refuses mutating tools in read-only executions without changing the catalog", async () => {
    const runtime = agentRuntime();
    const ctx = toolContext(runtime);
    ctx.readOnlyExecution = true;
    ctx.mutationAuthorizedByCurrentInput = false;
    const runTurn = vi.fn(async (input: any) => {
      await expect(input.executeTool({ callId: "m-1", name: "transferWalletFunds", arguments: {} })).resolves.toEqual({
        success: false,
        output: "Tool transferWalletFunds is not available for this request.",
      });
      return result("read-only answer");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: ctx,
      text: "summarize yesterday",
      timeoutMs: 1_000,
      host: fakeHost(runTurn),
    })).resolves.toMatchObject({ content: "read-only answer" });
  });

  it("keys sessions to the thread, the requester and the session contract", () => {
    const tools = sessionToolDefinitions(localToolDefinitionsForModel());
    const ctx = { threadKey: "discord:g:c", guildId: "g", channelId: "c", userId: "member-1" };
    const key = sessionKeyFor(ctx, "instructions", tools, "openai/gpt-6-luna");
    expect(sessionKeyFor(ctx, "instructions", tools, "gpt-6-luna")).toBe(key);
    expect(sessionKeyFor({ ...ctx, userId: "member-2" }, "instructions", tools, "openai/gpt-6-luna")).not.toBe(key);
    expect(sessionKeyFor({ ...ctx, threadKey: "discord:g:other" }, "instructions", tools, "openai/gpt-6-luna")).not.toBe(key);
    expect(sessionKeyFor(ctx, "changed instructions", tools, "openai/gpt-6-luna")).not.toBe(key);
    expect(sessionKeyFor(ctx, "instructions", tools, "openai/gpt-6-sol")).not.toBe(key);
    expect(nanocodeSessionId(key)).toBe(nanocodeSessionId(key));
  });

  it("offers earlier conversation only as bootstrap for a new session", async () => {
    const ctx = toolContext(agentRuntime());
    ctx.sessionMessages = [
      { role: "user", content: "first request", authorDisplayName: "Kartik", metadata: {} },
      { role: "assistant", content: "first answer", metadata: {} },
    ] as never;
    const prompt = await buildSessionPrompt(ctx, "second request", []);
    expect(prompt.bootstrap).toContain("Kartik: first request");
    expect(prompt.bootstrap).toContain("You: first answer");
    expect(prompt.text).not.toContain("first answer");
    expect(prompt.text).toContain('<message from="Kartik" user_id="user-1">\nsecond request\n</message>');
    expect(prompt.instructions).not.toContain("first request");
  });

  it("retries once on the fallback model when the primary fails before any tool ran", async () => {
    const runtime = agentRuntime();
    const calls: any[] = [];
    const runTurn = vi.fn(async (input: any) => {
      calls.push(input);
      if (calls.length === 1) throw new Error("provider unavailable");
      return result("fallback answer");
    });
    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "hello",
      timeoutMs: 1_000,
      host: fakeHost(runTurn),
    })).resolves.toMatchObject({ content: "fallback answer" });
    expect(calls.map((call) => call.model)).toEqual(["gpt-6-luna", "gpt-6-sol"]);
    expect(calls[1].requestId).toBe("request-1:fallback");
    expect(calls[1].sessionId).not.toBe(calls[0].sessionId);
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "agent.nanocodex.fallback_model" }));
  });

  it("does not retry on the fallback model after a tool ran", async () => {
    const runtime = agentRuntime();
    const runTurn = vi.fn(async (input: any) => {
      await input.executeTool({ callId: "c-1", name: "notRegistered", arguments: {} });
      throw new Error("provider unavailable");
    });
    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "hello",
      timeoutMs: 1_000,
      host: fakeHost(runTurn),
    })).rejects.toThrow("provider unavailable");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("steers a requester's follow-up into their running turn only", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const steer = vi.fn(async () => true);
    const host: NanocodeHostClient = {
      runTurn: vi.fn(async () => { await gate; return result("answered both"); }) as never,
      steer,
      activeRequest: () => undefined,
      stop: async () => undefined,
    };
    const running = executeNanoCodexAgentRuntime({ toolContext: toolContext(agentRuntime()), text: "first", timeoutMs: 5_000, host });
    await vi.waitFor(() => expect(host.runTurn).toHaveBeenCalled());

    await expect(steerActiveTurn({ threadKey: "discord:guild-1:channel-1", userId: "user-2", userDisplayName: "Other", steerId: "s-0", text: "not mine" }))
      .resolves.toBeUndefined();
    await expect(steerActiveTurn({ threadKey: "discord:guild-1:channel-1", userId: "user-1", userDisplayName: "Kartik", steerId: "s-1", text: "also this" }))
      .resolves.toBe("request-1");
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-1",
      steerId: "s-1",
      prompt: expect.objectContaining({ text: expect.stringContaining('<message from="Kartik" user_id="user-1">\nalso this\n</message>') }),
    }));

    release();
    await expect(running).resolves.toMatchObject({ content: "answered both" });
    await expect(steerActiveTurn({ threadKey: "discord:guild-1:channel-1", userId: "user-1", userDisplayName: "Kartik", steerId: "s-2", text: "late" }))
      .resolves.toBeUndefined();
  });

  it("keeps the canonical nested tool contract visible to the model", () => {
    const definitions = localToolDefinitionsForModel();
    const draw = definitions.find((tool) => tool.function.name === "drawRandom");
    expect(JSON.stringify(draw?.function.parameters)).toContain('"wager"');
    expect(draw?.function.parameters).toBe(
      localToolDefinitionsForModel().find((tool) => tool.function.name === "drawRandom")?.function.parameters,
    );
  });

  it("continues final synthesis when a non-mutating tool implementation throws", async () => {
    const runtime = agentRuntime();
    const ctx = toolContext(runtime);
    ctx.repo = { auditTool: vi.fn(async () => undefined) } as never;
    ctx.openRouter = {
      chat: vi.fn(async () => {
        throw new OpenRouterHttpError({ status: 400, message: "private provider detail" });
      }),
    } as never;
    const runRuntime = vi.fn(async (input: any) => {
      const toolResult = await input.executeTool({
        callId: "call-1",
        name: "inspectDiscordImages",
        arguments: {
          question: "What is shown?",
          imageUrls: ["https://example.com/image.png"],
          useContextImages: false,
        },
      });
      expect(toolResult).toMatchObject({
        success: false,
        output: expect.stringContaining("failed before returning usable evidence"),
        metadata: { status: "error" },
      });
      expect(toolResult.output).not.toContain("private provider detail");
      return result("I couldn’t inspect that image because the visual lookup failed.");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: ctx,
      text: "inspect this image",
      timeoutMs: 1_000,
      host: fakeHost(runRuntime),
    })).resolves.toMatchObject({
      content: "I couldn’t inspect that image because the visual lookup failed.",
    });

    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.tool.complete",
      metadata: expect.objectContaining({
        toolName: "inspectDiscordImages",
        status: "error",
        errorCode: "tool_execution_failed",
        retryable: false,
      }),
    }));
    expect(runtime.recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.runtime_failed",
    }));
  });

  it("does not deliver a purported summary after web research has no usable evidence", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      await input.executeTool({
        callId: "call-1",
        name: "web__run",
        arguments: { operations: [{ kind: "open", refId: "https://example.com/video" }] },
      });
      return result("Here is a high-level summary based on its preview.");
    });

    const response = await executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "summarize this video",
      timeoutMs: 1_000,
      host: fakeHost(runRuntime),
      executeToolRoute: (async () => ({
        content: "The requested content could not be retrieved.",
        status: "error" as const,
        errorCode: "external_evidence_missing",
        retryable: true,
      })) as never,
    });
    expect(response).toMatchObject({
      content: expect.stringContaining("could not be verified"),
      status: "error",
      errorCode: "external_evidence_missing",
    });
    expect(response.content).not.toContain("high-level summary based on its preview");
  });

  it("allows a response supported by a successful retry after an unavailable web result", async () => {
    const runtime = agentRuntime();
    const runRuntime = vi.fn(async (input: any) => {
      await input.executeTool({
        callId: "call-1",
        name: "web__run",
        arguments: { operations: [{ kind: "open", refId: "https://example.com/unavailable" }] },
      });
      await input.executeTool({
        callId: "call-2",
        name: "web__run",
        arguments: { operations: [{ kind: "search", query: "verified source" }] },
      });
      return result("Here is the verified answer.");
    });
    const executeToolRoute = vi
      .fn()
      .mockResolvedValueOnce({
        content: "The requested content could not be retrieved.",
        status: "error" as const,
        errorCode: "external_evidence_missing",
        retryable: true,
      })
      .mockResolvedValueOnce({ content: "Verified source result.", status: "ok" as const });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime),
      text: "find a current answer",
      timeoutMs: 1_000,
      host: fakeHost(runRuntime),
      executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({ content: "Here is the verified answer." });
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
      host: fakeHost(runRuntime),
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
      host: fakeHost(runRuntime),
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
      host: fakeHost(runRuntime), executeToolRoute: executeToolRoute as never,
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
      host: fakeHost(runRuntime),
      executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({
      content: "Generated image for: a gnome",
      files: [expect.objectContaining({ name: "generated.png", data: image.data })],
    });
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.post_tool_output_recovered",
    }));
  });

  it("reuses an identical successful paid generation within one turn", async () => {
    const runtime = agentRuntime();
    const image = { name: "generated.png", contentType: "image/png", data: Buffer.from("image") };
    const executeToolRoute = vi.fn(async () => ({ content: "Generated image", files: [image] }));
    const runRuntime = vi.fn(async (input: any) => {
      expect((await input.executeTool({ callId: "call-1", name: "generateImage", arguments: { prompt: "a gnome" } })).success).toBe(true);
      const repeated = await input.executeTool({ callId: "call-2", name: "generateImage", arguments: { prompt: "a gnome" } });
      expect(repeated).toMatchObject({ success: true, metadata: { status: "reused", reusedCallId: "call-1" } });
      return result("done");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime), text: "generate an image of a gnome", timeoutMs: 1_000,
      host: fakeHost(runRuntime), executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({ content: "done", files: [expect.objectContaining({ name: "generated.png" })] });
    expect(executeToolRoute).toHaveBeenCalledTimes(1);
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.tool.complete",
      metadata: expect.objectContaining({
        status: "reused",
        reusedCallId: "call-1",
        latencyBudgetMs: 120_000,
        latencyBudgetExceeded: false,
      }),
    }));
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.complete",
      summary: "Turn completed with 1 executed tool call; 1 duplicate call reused",
      metadata: expect.objectContaining({ toolCalls: 1, toolAttempts: 2, reusedToolCalls: 1 }),
    }));
  });

  it("executes an identical image inspection only once and reuses its evidence", async () => {
    const runtime = agentRuntime();
    const executeToolRoute = vi.fn(async () => ({ content: "Vision result: the image contains a sourced claim." }));
    const runRuntime = vi.fn(async (input: any) => {
      const first = await input.executeTool({
        callId: "call-1",
        name: "inspectDiscordImages",
        arguments: { messageIdOrUrl: "message-1", question: "What claim is shown?" },
      });
      const repeated = await input.executeTool({
        callId: "call-2",
        name: "inspectDiscordImages",
        arguments: { messageIdOrUrl: "message-1", question: "What claim is shown?" },
      });
      expect(first.output).toBe("Vision result: the image contains a sourced claim.");
      expect(repeated).toMatchObject({
        success: true,
        output: expect.stringContaining("Vision result: the image contains a sourced claim."),
        metadata: { status: "reused", reusedCallId: "call-1" },
      });
      return result("done");
    });

    await expect(executeNanoCodexAgentRuntime({
      toolContext: toolContext(runtime), text: "inspect this image", timeoutMs: 1_000,
      host: fakeHost(runRuntime), executeToolRoute: executeToolRoute as never,
    })).resolves.toMatchObject({ content: "done" });
    expect(executeToolRoute).toHaveBeenCalledTimes(1);
    expect(runtime.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.nanocodex.complete",
      metadata: expect.objectContaining({ toolCalls: 1, toolAttempts: 2, reusedToolCalls: 1 }),
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
      host: fakeHost(runRuntime),
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
      host: fakeHost(runRuntime),
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
      host: fakeHost(runRuntime), executeToolRoute: executeToolRoute as never,
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
        chatModel: "openai/gpt-6-luna",
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
    threadKey: "discord:guild-1:channel-1",
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

function result(finalMessage: string) {
  return { finalMessage, usage: { total_tokens: 12 }, resumed: false };
}

function fakeHost(runTurn: (input: any) => Promise<unknown>): NanocodeHostClient {
  return {
    runTurn: runTurn as NanocodeHostClient["runTurn"],
    steer: vi.fn(async () => false),
    activeRequest: () => undefined,
    stop: async () => undefined,
  };
}
