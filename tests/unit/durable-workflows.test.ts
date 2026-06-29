import { describe, expect, it, vi } from "vitest";
import { runDueDurableWorkflows } from "../../src/workflows/durable.js";

describe("durable workflows", () => {
  it("locks due workflows, runs matching runners, and records timeline events", async () => {
    const workflow = {
      id: "workflow-1",
      guildId: "guild-1",
      name: "Daily digest",
      kind: "digest",
      status: "active",
      schedule: "daily",
      state: {},
      lastStartedAt: null,
      lastCompletedAt: null,
      nextRunAt: new Date("2026-06-29T12:00:00.000Z"),
      lockedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    } as const;
    const repo = {
      listDueDurableWorkflows: vi.fn(async () => [workflow]),
      markDurableWorkflowRunStarted: vi.fn(async () => true),
      markDurableWorkflowRunFinished: vi.fn(async () => true),
      recordTraceEvent: vi.fn(async () => undefined)
    };

    const results = await runDueDurableWorkflows({
      repo,
      now: new Date("2026-06-29T13:00:00.000Z"),
      runners: [
        {
          kind: "digest",
          run: vi.fn(async () => ({
            state: { sent: true },
            nextRunAt: new Date("2026-06-30T13:00:00.000Z")
          }))
        }
      ]
    });

    expect(results).toEqual([{ id: "workflow-1", kind: "digest", status: "completed" }]);
    expect(repo.markDurableWorkflowRunStarted).toHaveBeenCalledWith({
      id: "workflow-1",
      lockedAt: new Date("2026-06-29T13:00:00.000Z")
    });
    expect(repo.markDurableWorkflowRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "workflow-1",
        status: "active",
        state: { sent: true },
        nextRunAt: new Date("2026-06-30T13:00:00.000Z")
      })
    );
    expect(repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "workflow.started" }));
    expect(repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "workflow.completed" }));
  });

  it("marks workflow failures durably", async () => {
    const workflow = {
      id: "workflow-2",
      guildId: "guild-1",
      name: "Digest",
      kind: "digest",
      status: "active",
      schedule: "daily",
      state: {},
      lastStartedAt: null,
      lastCompletedAt: null,
      nextRunAt: new Date(),
      lockedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    } as const;
    const repo = {
      listDueDurableWorkflows: vi.fn(async () => [workflow]),
      markDurableWorkflowRunStarted: vi.fn(async () => true),
      markDurableWorkflowRunFinished: vi.fn(async () => true),
      recordTraceEvent: vi.fn(async () => undefined)
    };

    const results = await runDueDurableWorkflows({
      repo,
      runners: [
        {
          kind: "digest",
          run: vi.fn(async () => {
            throw new Error("boom");
          })
        }
      ]
    });

    expect(results).toEqual([{ id: "workflow-2", kind: "digest", status: "failed" }]);
    expect(repo.markDurableWorkflowRunFinished).toHaveBeenCalledWith({
      id: "workflow-2",
      status: "failed",
      state: { lastError: "boom" },
      nextRunAt: null
    });
    expect(repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "workflow.failed", level: "error" }));
  });
});
