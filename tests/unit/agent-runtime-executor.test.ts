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
});
