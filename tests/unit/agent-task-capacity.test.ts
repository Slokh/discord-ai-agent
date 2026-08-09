import { describe, expect, it, vi } from "vitest";
import { waitForAgentTaskCapacity, waitForAgentTaskTerminal } from "../../src/jobs/agentTaskCapacity.js";

describe("agent task sandbox capacity", () => {
  it("keeps later work queued until the active sandbox finishes", async () => {
    const listActiveSandboxRuns = vi
      .fn()
      .mockResolvedValueOnce([{ sandboxRunId: "run-1" }])
      .mockResolvedValueOnce([{ sandboxRunId: "run-1" }])
      .mockResolvedValueOnce([]);
    const sleep = vi.fn(async () => undefined);
    const onWait = vi.fn();

    await waitForAgentTaskCapacity({
      repo: { listActiveSandboxRuns } as any,
      backend: "kubernetes-sandbox",
      maxConcurrent: 1,
      pollMs: 10,
      sleep,
      onWait,
    });

    expect(listActiveSandboxRuns).toHaveBeenCalledTimes(3);
    expect(listActiveSandboxRuns).toHaveBeenCalledWith({ backend: "kubernetes-sandbox", limit: 1 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalledOnce();
    expect(onWait).toHaveBeenCalledWith(1);
  });

  it("starts immediately when capacity is available", async () => {
    const listActiveSandboxRuns = vi.fn(async () => []);
    const sleep = vi.fn(async () => undefined);

    await waitForAgentTaskCapacity({
      repo: { listActiveSandboxRuns } as any,
      backend: "kubernetes-sandbox",
      maxConcurrent: 1,
      sleep,
    });

    expect(sleep).not.toHaveBeenCalled();
  });

  it("holds the queue worker until its launched task is terminal", async () => {
    const getAgentTask = vi
      .fn()
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "succeeded" });
    const sleep = vi.fn(async () => undefined);

    await waitForAgentTaskTerminal({
      repo: { getAgentTask } as any,
      taskId: "task-1",
      pollMs: 10,
      sleep,
    });

    expect(getAgentTask).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
