import { describe, expect, it, vi } from "vitest";
import { runSandboxReconciliationOnce } from "../../src/execution/reconciler.js";
import type { SandboxRunRecord } from "../../src/db/repositories.js";

describe("sandbox reconciler", () => {
  it("marks active tasks failed when the Kubernetes Job fails", async () => {
    const run = sandboxRun();
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => [run]),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => []),
      markAgentTaskFailed: vi.fn(async () => undefined)
    };
    const backend = {
      observeRun: vi.fn(async () => ({
        status: "failed" as const,
        reason: "BackoffLimitExceeded",
        metadata: { failed: 1 }
      })),
      cleanupRun: vi.fn()
    };

    await runSandboxReconciliationOnce(repo as any, backend);

    expect(repo.markAgentTaskFailed).toHaveBeenCalledWith({
      taskId: "task-1",
      error: "BackoffLimitExceeded",
      metadata: {
        sandboxRunId: "run-1",
        observed: {
          status: "failed",
          reason: "BackoffLimitExceeded",
          metadata: { failed: 1 }
        }
      }
    });
  });

  it("cleans terminal sandbox resources and records cleanup", async () => {
    const run = sandboxRun({ taskStatus: "succeeded", status: "succeeded" });
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => []),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => [run]),
      markSandboxRunCleanedUp: vi.fn(async () => undefined)
    };
    const backend = {
      observeRun: vi.fn(),
      cleanupRun: vi.fn(async () => undefined)
    };

    await runSandboxReconciliationOnce(repo as any, backend);

    expect(backend.cleanupRun).toHaveBeenCalledWith(run);
    expect(repo.markSandboxRunCleanedUp).toHaveBeenCalledWith("run-1");
  });
});

function sandboxRun(overrides: Partial<SandboxRunRecord> = {}): SandboxRunRecord {
  return {
    sandboxRunId: "run-1",
    taskId: "task-1",
    taskStatus: "running",
    backend: "kubernetes-sandbox",
    namespace: "discord-ai-agent",
    backendJobName: "agent-task-test",
    image: "sandbox:latest",
    status: "running",
    metadata: {},
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
    cleanedUpAt: null,
    updatedAt: new Date("2026-01-01T00:00:01Z"),
    ...overrides
  };
}
