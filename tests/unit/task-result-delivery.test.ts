import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentTaskRecord, TaskEvent } from "../../src/db/repositories.js";
import { parseDiscordDeliveryIntent } from "../../src/discord/deliveryIntent.js";
import {
  AGENT_TASK_RESULT_DELIVERY_KIND,
  agentTaskResultTarget,
  enqueueAgentTaskResultDeliveries,
  resultFileReferences,
} from "../../src/discord/taskResultDelivery.js";
import { formatAgentTaskResult } from "../../src/tools/agentTaskFormatting.js";

describe("agent task result formatting", () => {
  it("reports the agent's own result for result-profile tasks", () => {
    for (const [taskType, step] of [["diagnosis", "diagnosis_complete"], ["diagnosis", "result_complete"], ["computer_task", "result_complete"]] as const) {
      const content = formatAgentTaskResult({
        taskId: "task-1",
        jobId: null,
        job: agentTask({ taskType, status: "succeeded" }),
        taskEvents: [taskEvent({ summary: "Beat level one in four tries; the boss jumps on a timer.", step })],
      });
      expect(content).toBe("Beat level one in four tries; the boss jumps on a timer.");
    }
  });

  it("does not talk about pull requests when a computer task fails", () => {
    const content = formatAgentTaskResult({
      taskId: "task-1",
      jobId: null,
      job: agentTask({ taskType: "computer_task", status: "failed", error: "Wine could not start the program." }),
    });
    expect(content).toContain("I couldn’t finish that");
    expect(content).not.toContain("PR");
  });

  it("keeps the pull-request result for code changes", () => {
    const content = formatAgentTaskResult({
      taskId: "task-1",
      jobId: null,
      job: agentTask({ status: "succeeded", prUrl: "https://github.com/o/r/pull/7" }),
    });
    expect(content).toContain("Done: https://github.com/o/r/pull/7");
  });
});

describe("agent task result delivery", () => {
  it("replies to the requester's message when the task came from chat", () => {
    expect(agentTaskResultTarget(agentTask({ traceId: "123456789012345678", channelId: "c1" })))
      .toEqual({ channelId: "c1", sourceMessageId: "123456789012345678" });
    expect(agentTaskResultTarget(agentTask({ traceId: "reaction-retry-x", discordResponseChannelId: "c2", discordResponseMessageId: "m2" })))
      .toEqual({ channelId: "c2", sourceMessageId: "m2" });
    expect(agentTaskResultTarget(agentTask({ traceId: null, discordResponseChannelId: null, discordResponseMessageId: null }))).toBeNull();
  });

  it("attaches only files the agent delivered, in delivery order, with unique names", () => {
    const sha = "a".repeat(64);
    const refs = resultFileReferences([
      { artifactId: "a2", name: "screen.png", contentType: "image/png", sizeBytes: 10, metadata: { deliver: true, order: 1, sha256: sha } },
      { artifactId: "a1", name: "screen.png", contentType: "image/png", sizeBytes: 10, metadata: { deliver: true, order: 0, sha256: sha } },
      { artifactId: "a3", name: "notes.txt", contentType: "text/plain", sizeBytes: 3, metadata: { sha256: sha } },
    ]);
    expect(refs.map((ref) => [ref.artifactId, ref.name])).toEqual([["a1", "screen.png"], ["a2", "screen-1.png"]]);
  });

  it("enqueues one durable intent and obligation per finished task", async () => {
    const data = Buffer.from("png-bytes");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const task = agentTask({ taskType: "computer_task", status: "succeeded", traceId: "123456789012345678", threadKey: "discord:g:c" });
    const stored: Array<{ kind: string; content: string }> = [];
    const repo = {
      listAgentTasksAwaitingResultDelivery: vi.fn(async (_input: { taskTypes: string[] }) => [task]),
      getAgentRuntimeTaskEventsForTask: vi.fn(async () => [taskEvent({ summary: "I won the first round.", step: "result_complete" })]),
      getSandboxCommandEvents: vi.fn(async () => []),
      markAgentTaskRendered: vi.fn(async () => undefined),
      markAgentTaskNotificationFailed: vi.fn(async () => undefined),
    };
    const agentRuntime = {
      getExecution: vi.fn(async () => ({ sessionId: "session-1" })),
      listArtifactsForExecution: vi.fn(async () => [
        { artifactId: "file-1", name: "final.png", contentType: "image/png", sizeBytes: data.length, metadata: { deliver: true, order: 0, sha256 } },
      ]),
      storeArtifact: vi.fn(async (input: { kind: string; content: string }) => {
        stored.push(input);
        return { artifactId: "intent-1" };
      }),
    };
    const obligations = { upsertPending: vi.fn(async () => undefined) };

    const count = await enqueueAgentTaskResultDeliveries({
      repo: repo as any,
      agentRuntime: agentRuntime as any,
      obligations: obligations as any,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
    });

    expect(count).toBe(1);
    expect(repo.listAgentTasksAwaitingResultDelivery).toHaveBeenCalledWith(expect.objectContaining({
      taskTypes: expect.arrayContaining(["code_update", "diagnosis", "computer_task"]),
    }));
    expect(repo.listAgentTasksAwaitingResultDelivery.mock.calls[0]?.[0].taskTypes).not.toContain("improvement_report");
    const intent = parseDiscordDeliveryIntent(stored[0]!.content);
    expect(intent).toMatchObject({ deliveryKey: "agent-task-result:task-1", requesterUserId: "user-1", content: "I won the first round." });
    expect(intent.files).toEqual([expect.objectContaining({ artifactId: "file-1", name: "final.png", sha256 })]);
    expect(obligations.upsertPending).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "agent-task-execution-task-1",
      channelId: "channel-1",
      sourceMessageId: "123456789012345678",
      metadata: expect.objectContaining({ kind: AGENT_TASK_RESULT_DELIVERY_KIND, deliveryIntentArtifactId: "intent-1" }),
    }));
    expect(repo.markAgentTaskRendered).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", terminal: true }));
  });

  it("parks a task without a reply target instead of retrying forever", async () => {
    const repo = {
      listAgentTasksAwaitingResultDelivery: vi.fn(async () => [agentTask({ userId: null })]),
      markAgentTaskNotificationFailed: vi.fn(async () => undefined),
    };
    const count = await enqueueAgentTaskResultDeliveries({
      repo: repo as any,
      agentRuntime: {} as any,
      obligations: {} as any,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
    });
    expect(count).toBe(0);
    expect(repo.markAgentTaskNotificationFailed).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
  });
});

function agentTask(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  const now = new Date("2026-06-30T12:00:00Z");
  return {
    taskId: "task-1",
    pgBossJobId: "job-1",
    traceId: "trace-1",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    threadKey: null,
    discordResponseChannelId: "channel-1",
    discordResponseMessageId: "message-1",
    retriedFromTaskId: null,
    improvementCaseId: null,
    taskType: "code_update",
    title: "Play the game",
    request: "try the linked game",
    requestedBy: "tester",
    status: "running",
    backend: "kubernetes-sandbox",
    currentStep: null,
    statusMessage: null,
    branchName: null,
    prUrl: null,
    draft: null,
    verifyPassed: null,
    error: null,
    createdAt: now,
    startedAt: now,
    cancelledAt: null,
    completedAt: now,
    notifiedAt: null,
    notificationError: null,
    progressUpdatedAt: now,
    lastRenderedSignature: null,
    lastRenderedAt: null,
    terminalRenderedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function taskEvent(overrides: Partial<TaskEvent> & { step?: string } = {}): TaskEvent {
  const { step, ...rest } = overrides;
  return {
    id: 1,
    taskId: "task-1",
    traceId: "trace-1",
    eventName: "agent.task.progress",
    level: "info",
    summary: null,
    metadata: step ? { step } : {},
    createdAt: new Date("2026-06-30T12:00:30Z"),
    ...rest,
  } as TaskEvent;
}
