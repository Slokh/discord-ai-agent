import { describe, expect, it, vi } from "vitest";
import { reconcileStaleAgentRuntimeExecutions } from "../../src/agent/runtimeReconciler.js";

describe("agent runtime reconciler", () => {
  it("terminalizes stale non-task executions with a typed event", async () => {
    const failExecutionIfStale = vi.fn(async () => ({ executionId: "execution-stale" }));
    const recordEvent = vi.fn(async () => undefined);
    const listStaleExecutions = vi.fn(async () => [{ executionId: "execution-stale", sessionId: "session-stale", traceId: "trace-stale" }]);
    await expect(reconcileStaleAgentRuntimeExecutions({
      repo: { listStaleExecutions, failExecutionIfStale, recordEvent } as any,
      now: new Date("2026-08-03T12:00:00Z"),
      staleAfterMs: 15 * 60 * 1000,
    })).resolves.toBe(1);
    expect(listStaleExecutions).toHaveBeenCalledWith({ before: new Date("2026-08-03T11:45:00Z"), limit: 20 });
    expect(failExecutionIfStale).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-stale",
      before: new Date("2026-08-03T11:45:00Z"),
    }));
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "agent.execution.stale_failed", level: "error" }));
  });

  it("does not overwrite or emit an error for an execution that completed after selection", async () => {
    const recordEvent = vi.fn(async () => undefined);
    await expect(reconcileStaleAgentRuntimeExecutions({
      repo: {
        listStaleExecutions: vi.fn(async () => [{ executionId: "execution-fresh", sessionId: "session", traceId: null }]),
        failExecutionIfStale: vi.fn(async () => undefined),
        recordEvent,
      } as any,
      now: new Date("2026-08-03T12:00:00Z"),
    })).resolves.toBe(0);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
