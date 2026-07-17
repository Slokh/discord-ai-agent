import { beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessAgentRuntimePromptExecutor } from "../../src/agent/runtimeExecutor.js";
import { handleAgentRequest } from "../../src/agent/router.js";

vi.mock("../../src/agent/router.js", () => ({
  handleAgentRequest: vi.fn()
}));

describe("agent runtime prompt executors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("aborts late agent work when the runtime deadline expires", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(handleAgentRequest).mockImplementation(async (ctx) => {
      capturedSignal = ctx.abortSignal;
      return await new Promise(() => undefined);
    });
    const executor = new InProcessAgentRuntimePromptExecutor();
    const request = executor.execute({
      toolContext: { requestId: "request-timeout" } as never,
      text: "hello",
      timeoutMs: 1_000,
      turnEnvelope: { requestId: "request-timeout" } as never,
    });
    const assertion = expect(request).rejects.toThrow("timed out after 1000ms");

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
