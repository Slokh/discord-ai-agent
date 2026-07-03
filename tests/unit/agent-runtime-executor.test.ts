import { describe, expect, it, vi } from "vitest";
import { InProcessAgentRuntimePromptExecutor, WarmSandboxAgentRuntimePromptExecutor } from "../../src/agent/runtimeExecutor.js";
import { handleAgentRequest } from "../../src/agent/router.js";

vi.mock("../../src/agent/router.js", () => ({
  handleAgentRequest: vi.fn()
}));

describe("agent runtime prompt executors", () => {
  it("runs the compatibility model loop in-process", async () => {
    vi.mocked(handleAgentRequest).mockResolvedValue({ content: "hello" });
    const executor = new InProcessAgentRuntimePromptExecutor();

    await expect(
      executor.execute({
        toolContext: { requestId: "request-1" } as never,
        text: "hello",
        timeoutMs: 1000,
        turnEnvelope: { requestId: "request-1" } as never
      })
    ).resolves.toEqual({ content: "hello" });

    expect(handleAgentRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-1" }), "hello");
  });

  it("fails warm-sandbox executions at the executor boundary while the backend is being implemented", async () => {
    const executor = new WarmSandboxAgentRuntimePromptExecutor();

    await expect(
      executor.execute({
        toolContext: { requestId: "request-1" } as never,
        text: "hello",
        timeoutMs: 1000,
        turnEnvelope: { requestId: "request-1" } as never
      })
    ).rejects.toThrow("Warm sandbox agent runtime execution is not implemented yet");
  });
});
