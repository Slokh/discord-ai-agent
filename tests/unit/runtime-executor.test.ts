import { describe, expect, it, vi } from "vitest";

const { executeNanoCodexAgentRuntime } = vi.hoisted(() => ({
  executeNanoCodexAgentRuntime: vi.fn(async () => ({ content: "done" })),
}));

vi.mock("../../src/agent/nanocodexAgentRuntime.js", () => ({
  executeNanoCodexAgentRuntime,
}));

import { NanoCodexAgentRuntimePromptExecutor } from "../../src/agent/runtimeExecutor.js";

describe("NanoCodexAgentRuntimePromptExecutor", () => {
  it("forwards the scoped prompt and timeout policy to NanoCodex", async () => {
    const executor = new NanoCodexAgentRuntimePromptExecutor();
    const toolContext = { requestId: "request-1" };

    await expect(executor.execute({
      toolContext: toolContext as never,
      text: "hello",
      timeoutMs: 1_000,
      silenceTimeoutMs: 200,
      hardTimeoutMs: 2_000,
      turnEnvelope: {} as never,
      inputLinesArtifactId: "artifact-1",
      inputLines: ["ignored by the retained runtime"],
    })).resolves.toEqual({ content: "done" });

    expect(executor.name).toBe("nanocodex");
    expect(executeNanoCodexAgentRuntime).toHaveBeenCalledWith({
      toolContext,
      text: "hello",
      timeoutMs: 1_000,
      silenceTimeoutMs: 200,
      hardTimeoutMs: 2_000,
    });
  });
});
