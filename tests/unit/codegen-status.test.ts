import { describe, expect, it } from "vitest";
import {
  diagnoseCodegenStatus,
  formatCodegenStatusSnapshot,
  staleActiveTasks,
  staleSandboxLeases,
  type CodegenStatusSnapshot
} from "../../src/observability/codegenStatus.js";

describe("codegen status formatter", () => {
  it("surfaces stale work, lease health, queue backlog, and cleanup backlog", () => {
    const snapshot = snapshotFixture();

    expect(staleActiveTasks(snapshot).map((task) => task.taskId)).toEqual(["task-stale"]);
    expect(staleSandboxLeases(snapshot).map((lease) => lease.sandboxId)).toEqual(["sandbox-stale"]);
    expect(diagnoseCodegenStatus(snapshot)).toEqual(
      expect.arrayContaining([
        "1 active task has not progressed within the stale threshold.",
        "pg-boss has 3 live agent.task jobs for 2 tracked active tasks.",
        "1 codegen sandbox lease has stale heartbeats.",
        "1 terminal sandbox run still needs cleanup.",
        "1 recent terminal task failed; inspect the run or terminal artifact for the first error."
      ])
    );

    const report = formatCodegenStatusSnapshot(snapshot);

    expect(report).toContain("Codegen status");
    expect(report).toContain("active agent sessions: 1 | active tasks: 2 | stale active: 1");
    expect(report).toContain("Agent runtime session counts: running=1");
    expect(report).toContain("agent-session-active running | execution=running | harness=opencode");
    expect(report).toContain("pg-boss agent.task queue: active=1, created=2");
    expect(report).toContain("task-stale running stale");
    expect(report).toContain("sandbox-stale leased stale");
    expect(report).toContain("Sandbox cleanup backlog:");
    expect(report).toContain("task-failed failed");
  });

  it("prints a calm empty snapshot", () => {
    const snapshot = {
      ...snapshotFixture(),
      taskCounts: [],
      queueCounts: [],
      agentSessionCounts: [],
      activeAgentSessions: [],
      activeTasks: [],
      recentTerminalTasks: [],
      activeSandboxRuns: [],
      pendingSandboxCleanup: [],
      leases: []
    };

    expect(diagnoseCodegenStatus(snapshot)).toEqual(["No active code-update tasks."]);
    expect(formatCodegenStatusSnapshot(snapshot)).toContain("Task counts: none");
  });
});

function snapshotFixture(): CodegenStatusSnapshot {
  const generatedAt = new Date("2026-07-01T12:30:00.000Z");
  return {
    generatedAt,
    staleAfterMs: 15 * 60 * 1000,
    agentSessionCounts: [{ name: "running", count: 1 }],
    activeAgentSessions: [
      {
        sessionId: "agent-session-active",
        traceId: "trace-agent",
        threadKey: "discord:guild:channel",
        title: "Discord prompt",
        requestedBy: "kartik",
        status: "running",
        harness: "opencode",
        model: "z-ai/glm-5.2",
        executionId: "agent-execution-active",
        executionStatus: "running",
        createdAt: new Date("2026-07-01T12:20:00.000Z"),
        startedAt: new Date("2026-07-01T12:20:01.000Z"),
        completedAt: null,
        updatedAt: new Date("2026-07-01T12:25:00.000Z"),
        executionUpdatedAt: new Date("2026-07-01T12:25:00.000Z")
      }
    ],
    taskCounts: [
      { name: "failed", count: 1 },
      { name: "queued", count: 1 },
      { name: "running", count: 1 }
    ],
    queueCounts: [
      { name: "active", count: 1 },
      { name: "created", count: 2 }
    ],
    activeTasks: [
      {
        taskId: "task-stale",
        traceId: "trace-stale",
        title: "Replace Thinking reply",
        requestedBy: "kartik",
        status: "running",
        backend: "local-process-sandbox",
        currentStep: "codex",
        statusMessage: "Running codegen.",
        branchName: null,
        prUrl: null,
        error: null,
        createdAt: new Date("2026-07-01T12:00:00.000Z"),
        startedAt: new Date("2026-07-01T12:01:00.000Z"),
        completedAt: null,
        progressUpdatedAt: new Date("2026-07-01T12:10:00.000Z"),
        updatedAt: new Date("2026-07-01T12:10:00.000Z")
      },
      {
        taskId: "task-fresh",
        traceId: "trace-fresh",
        title: "Update UI title",
        requestedBy: "kartik",
        status: "queued",
        backend: "local-process-sandbox",
        currentStep: "queued",
        statusMessage: null,
        branchName: null,
        prUrl: null,
        error: null,
        createdAt: new Date("2026-07-01T12:28:00.000Z"),
        startedAt: null,
        completedAt: null,
        progressUpdatedAt: new Date("2026-07-01T12:28:00.000Z"),
        updatedAt: new Date("2026-07-01T12:28:00.000Z")
      }
    ],
    recentTerminalTasks: [
      {
        taskId: "task-failed",
        traceId: "trace-failed",
        title: "Change prompt",
        requestedBy: "kartik",
        status: "failed",
        backend: "kubernetes-sandbox",
        currentStep: "failed",
        statusMessage: "Codegen failed.",
        branchName: null,
        prUrl: null,
        error: "No diff before deadline.",
        createdAt: new Date("2026-07-01T11:00:00.000Z"),
        startedAt: new Date("2026-07-01T11:01:00.000Z"),
        completedAt: new Date("2026-07-01T11:20:00.000Z"),
        progressUpdatedAt: new Date("2026-07-01T11:20:00.000Z"),
        updatedAt: new Date("2026-07-01T11:20:00.000Z")
      }
    ],
    activeSandboxRuns: [
      {
        sandboxRunId: "run-active",
        taskId: "task-stale",
        taskStatus: "running",
        backend: "local-process-sandbox",
        namespace: null,
        backendJobName: null,
        status: "running",
        startedAt: new Date("2026-07-01T12:01:00.000Z"),
        completedAt: null,
        cleanedUpAt: null,
        updatedAt: new Date("2026-07-01T12:10:00.000Z")
      }
    ],
    pendingSandboxCleanup: [
      {
        sandboxRunId: "run-cleanup",
        taskId: "task-failed",
        taskStatus: "failed",
        backend: "kubernetes-sandbox",
        namespace: "agents",
        backendJobName: "agent-task",
        status: "failed",
        startedAt: new Date("2026-07-01T11:01:00.000Z"),
        completedAt: new Date("2026-07-01T11:20:00.000Z"),
        cleanedUpAt: null,
        updatedAt: new Date("2026-07-01T11:20:00.000Z")
      }
    ],
    leases: [
      {
        sandboxId: "sandbox-stale",
        repo: "Slokh/discord-ai-agent",
        backend: "local-process-sandbox",
        status: "leased",
        leaseOwner: "worker-a",
        executionId: "execution-stale",
        heartbeatAt: new Date("2026-07-01T12:00:00.000Z"),
        lastUsedAt: new Date("2026-07-01T12:00:00.000Z"),
        updatedAt: new Date("2026-07-01T12:00:00.000Z")
      },
      {
        sandboxId: "sandbox-idle",
        repo: "Slokh/discord-ai-agent",
        backend: "local-process-sandbox",
        status: "idle",
        leaseOwner: null,
        executionId: null,
        heartbeatAt: new Date("2026-07-01T12:29:00.000Z"),
        lastUsedAt: new Date("2026-07-01T12:29:00.000Z"),
        updatedAt: new Date("2026-07-01T12:29:00.000Z")
      }
    ]
  };
}
