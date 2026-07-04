import { afterEach, describe, expect, it, vi } from "vitest";
import { executeInProcessAgentRuntime, isAgentRuntimeTimeoutError } from "../../src/agent/inProcessRuntimeExecutor.js";
import { handleAgentRequest } from "../../src/agent/router.js";

vi.mock("../../src/agent/router.js", () => ({
  handleAgentRequest: vi.fn()
}));

describe("in-process agent runtime executor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("delegates to the compatibility model router", async () => {
    vi.mocked(handleAgentRequest).mockResolvedValue({ content: "hello" });

    await expect(
      executeInProcessAgentRuntime({
        toolContext: { requestId: "request-1" } as never,
        text: "hello",
        timeoutMs: 1000
      })
    ).resolves.toEqual({ content: "hello" });

    expect(handleAgentRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-1" }), "hello");
  });

  it("raises a runtime timeout error", async () => {
    vi.useFakeTimers();
    vi.mocked(handleAgentRequest).mockReturnValue(new Promise(() => undefined));

    const execution = executeInProcessAgentRuntime({
      toolContext: { requestId: "request-1" } as never,
      text: "slow",
      timeoutMs: 100
    });
    const expectation = expect(execution).rejects.toSatisfy(isAgentRuntimeTimeoutError);
    await vi.advanceTimersByTimeAsync(100);

    await expectation;
  });
});
