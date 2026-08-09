import { describe, expect, it, vi } from "vitest";
import { runSandboxReconciliationOnce } from "../../src/execution/reconciler.js";
import type { SandboxRunRecord } from "../../src/db/repositories.js";

describe("sandbox reconciler", () => {
  it("marks active tasks failed when the Kubernetes Job fails", async () => {
    const run = sandboxRun();
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => [run]),
      listStaleRunningAgentTasksWithoutActiveSandbox: vi.fn(async () => []),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => []),
      markAgentTaskFailed: vi.fn(async () => undefined)
    };
    const backend = {
      name: "kubernetes-sandbox",
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
        },
        failureCode: "sandbox_unknown",
        diagnosticsStatus: "unavailable",
        failureDiagnosis: expect.objectContaining({
          code: "sandbox_unknown",
          summary: expect.stringContaining("stopped unexpectedly"),
          diagnosticsStatus: "unavailable",
        }),
      }
    });
  });

  it("stores failed pod logs as a redacted runtime artifact instead of task metadata", async () => {
    const run = sandboxRun();
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => [run]),
      listStaleRunningAgentTasksWithoutActiveSandbox: vi.fn(async () => []),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => []),
      markAgentTaskFailed: vi.fn(async () => undefined),
    };
    const agentRuntime = {
      getExecution: vi.fn(async () => ({ sessionId: "session-1", executionId: "agent-task-execution-task-1" })),
      storeArtifact: vi.fn(async () => ({ artifactId: "artifact-1" })),
    };
    const backend = {
      name: "kubernetes-sandbox",
      observeRun: vi.fn(async () => ({ status: "failed" as const, reason: "failed", diagnosticLog: "sensitive log tail" })),
      cleanupRun: vi.fn(),
    };

    await runSandboxReconciliationOnce(repo as any, backend, { agentRuntime: agentRuntime as any });

    expect(agentRuntime.storeArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: "command_log",
      content: "sensitive log tail",
      metadata: expect.objectContaining({ source: "kubernetes_pod_log", bounded: true }),
    }));
    expect(repo.markAgentTaskFailed).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        diagnosticArtifactId: "artifact-1",
        observed: expect.not.objectContaining({ diagnosticLog: expect.anything() }),
      }),
    }));
  });

  it("records one progress transition while Kubernetes retries the sandbox", async () => {
    const run = sandboxRun();
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => [run]),
      listStaleRunningAgentTasksWithoutActiveSandbox: vi.fn(async () => []),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => []),
      getAgentTask: vi.fn(async () => agentTask({ currentStep: "sandbox_running" })),
      markAgentTaskProgress: vi.fn(async () => undefined),
    };
    const backend = {
      name: "kubernetes-sandbox",
      observeRun: vi.fn(async () => ({ status: "running" as const, metadata: { failed: 1, active: 1, retrying: true } })),
      cleanupRun: vi.fn(),
    };

    await runSandboxReconciliationOnce(repo as any, backend);

    expect(repo.markAgentTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      step: "sandbox_retrying",
      statusMessage: expect.stringContaining("retrying once automatically"),
    }));
  });

  it("cleans terminal sandbox resources and records cleanup", async () => {
    const run = sandboxRun({ taskStatus: "succeeded", status: "succeeded" });
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => []),
      listStaleRunningAgentTasksWithoutActiveSandbox: vi.fn(async () => []),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => [run]),
      markSandboxRunCleanedUp: vi.fn(async () => undefined)
    };
    const backend = {
      name: "kubernetes-sandbox",
      observeRun: vi.fn(),
      cleanupRun: vi.fn(async () => undefined)
    };

    await runSandboxReconciliationOnce(repo as any, backend);

    expect(backend.cleanupRun).toHaveBeenCalledWith(run);
    expect(repo.markSandboxRunCleanedUp).toHaveBeenCalledWith("run-1");
  });

  it("marks stale running tasks failed when no active sandbox run exists", async () => {
    const task = agentTask();
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => []),
      listStaleRunningAgentTasksWithoutActiveSandbox: vi.fn(async () => [task]),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => []),
      markAgentTaskFailed: vi.fn(async () => undefined)
    };
    const backend = {
      name: "kubernetes-sandbox",
      observeRun: vi.fn(),
      cleanupRun: vi.fn()
    };

    await runSandboxReconciliationOnce(repo as any, backend, {
      staleRunningTaskMs: 15 * 60_000,
      now: () => new Date("2026-01-01T00:30:00Z").getTime()
    });

    expect(repo.listStaleRunningAgentTasksWithoutActiveSandbox).toHaveBeenCalledWith({
      staleBefore: new Date("2026-01-01T00:15:00Z")
    });
    expect(repo.markAgentTaskFailed).toHaveBeenCalledWith({
      taskId: "task-1",
      error: "Agent task was running without an active sandbox after the stale threshold.",
      metadata: expect.objectContaining({
        reason: "stale_running_task_without_active_sandbox",
        staleBefore: "2026-01-01T00:15:00.000Z",
        staleRunningTaskMs: 900_000,
        lastProgressAt: "2026-01-01T00:10:00.000Z",
        currentStep: "sandbox_running",
        backend: "local-process-sandbox"
      })
    });
    expect(backend.cleanupRun).not.toHaveBeenCalled();
  });

  it("ignores active sandbox runs owned by a different backend", async () => {
    const localRun = sandboxRun({ backend: "local-process-sandbox", namespace: null });
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => [localRun]),
      listStaleRunningAgentTasksWithoutActiveSandbox: vi.fn(async () => []),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => []),
      markAgentTaskFailed: vi.fn(async () => undefined)
    };
    const backend = {
      name: "kubernetes-sandbox",
      observeRun: vi.fn(),
      cleanupRun: vi.fn()
    };

    await runSandboxReconciliationOnce(repo as any, backend);

    expect(backend.observeRun).not.toHaveBeenCalled();
    expect(repo.markAgentTaskFailed).not.toHaveBeenCalled();
  });

  it("does not clean terminal sandbox runs owned by a different backend", async () => {
    const localRun = sandboxRun({
      taskStatus: "succeeded",
      backend: "local-process-sandbox",
      namespace: null,
      status: "succeeded"
    });
    const repo = {
      listActiveSandboxRuns: vi.fn(async () => []),
      listStaleRunningAgentTasksWithoutActiveSandbox: vi.fn(async () => []),
      listTerminalSandboxRunsPendingCleanup: vi.fn(async () => [localRun]),
      markSandboxRunCleanedUp: vi.fn(async () => undefined)
    };
    const backend = {
      name: "kubernetes-sandbox",
      observeRun: vi.fn(),
      cleanupRun: vi.fn()
    };

    await runSandboxReconciliationOnce(repo as any, backend);

    expect(backend.cleanupRun).not.toHaveBeenCalled();
    expect(repo.markSandboxRunCleanedUp).not.toHaveBeenCalled();
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

function agentTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    pgBossJobId: "job-1",
    traceId: "trace-1",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    threadKey: null,
    discordResponseChannelId: null,
    discordResponseMessageId: null,
    retriedFromTaskId: null,
    taskType: "code_update",
    title: "stale task",
    request: "make a change",
    requestedBy: "test",
    status: "running",
    backend: "local-process-sandbox",
    currentStep: "sandbox_running",
    statusMessage: "Running codegen.",
    branchName: null,
    prUrl: null,
    draft: null,
    verifyPassed: null,
    error: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: new Date("2026-01-01T00:00:01Z"),
    cancelledAt: null,
    completedAt: null,
    notifiedAt: null,
    notificationError: null,
    progressUpdatedAt: new Date("2026-01-01T00:10:00Z"),
    lastRenderedSignature: null,
    lastRenderedAt: null,
    terminalRenderedAt: null,
    updatedAt: new Date("2026-01-01T00:10:00Z"),
    ...overrides,
  };
}
