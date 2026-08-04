import { describe, expect, it } from "vitest";
import { bugReportResultReplyPayload, renderAgentTaskMessage } from "../../src/discord/taskNotifications.js";
import type { AgentTaskRecord, TaskEvent } from "../../src/db/repositories.js";

describe("agent task Discord notifications", () => {
  it("renders a concise live status message while a task is running", () => {
    const task = agentTask({ status: "running", statusMessage: "Preparing the sandbox." });

    expect(renderAgentTaskMessage(task).content).toBe(
      [
        "Working on `Improve thing`.",
        "Preparing the sandbox.",
        "Current phase: sandbox running",
        "Started <t:1782820800:R> · last progress <t:1782820800:R>",
        "Task ID: `task-1`"
      ].join("\n")
    );
  });

  it("renders recent activity for running tasks", () => {
    const task = agentTask({
      status: "running",
      currentStep: "nanocodex_first_edit",
      statusMessage: "NanoCodex made its first code edit."
    });
    const events = [
      taskEvent({ id: 1, summary: "Repository ready.", step: "repo_complete", createdAt: new Date("2026-06-30T12:00:05Z") }),
      taskEvent({ id: 2, summary: "NanoCodex is using read_file.", step: "nanocodex_tool_read_file", createdAt: new Date("2026-06-30T12:00:10Z") }),
      taskEvent({ id: 3, summary: "NanoCodex made its first code edit.", step: "nanocodex_first_edit", createdAt: new Date("2026-06-30T12:00:15Z") })
    ];

    expect(renderAgentTaskMessage(task, events).content).toBe(
      [
        "Working on `Improve thing`.",
        "NanoCodex made its first code edit.",
        "Current phase: first edit made",
        "Started <t:1782820800:R> · last progress <t:1782820800:R>",
        "Recent activity:",
        "- <t:1782820805:T> repository ready: Repository ready.",
        "- <t:1782820810:T> nanocodex tool read file: NanoCodex is using read_file.",
        "Task ID: `task-1`"
      ].join("\n")
    );
  });

  it("renders no-diff terminal failures bluntly", () => {
    const task = agentTask({
      status: "no_changes",
      currentStep: "no_changes",
      statusMessage: "Agent task produced no diff after NanoCodex attempt; no PR will be opened.",
      error: "Agent task produced no diff after NanoCodex attempt; no PR will be opened.",
      completedAt: new Date("2026-06-30T12:01:00Z")
    });

    expect(renderAgentTaskMessage(task).content).toContain("No PR opened: the coding agent did not produce a code diff.");
  });

  it("delivers the grounded result of a successful read-only diagnosis", () => {
    const task = agentTask({
      taskType: "diagnosis",
      status: "succeeded",
      completedAt: new Date("2026-06-30T12:01:00Z")
    });
    const events = [taskEvent({
      summary: "The CI job is slow because dependency caching misses on every sandbox.",
      step: "diagnosis_complete"
    })];
    expect(renderAgentTaskMessage(task, events).content).toBe(
      "The CI job is slow because dependency caching misses on every sandbox."
    );
  });

  it("pings only the bug reporter when triage needs more context", () => {
    const payload = bugReportResultReplyPayload(
      { disposition: "insufficient_evidence", reportedByUserId: "reporter-1" },
      "🐛 Validation finished: I need the expected result.",
      2_000,
    );

    expect(payload.content).toContain("<@reporter-1>");
    expect(payload.content).toContain("Please reply to this message");
    expect(payload.allowedMentions).toEqual({ parse: [], users: ["reporter-1"], repliedUser: false });
  });

  it("does not ping the reporter for a conclusive bug verdict", () => {
    const payload = bugReportResultReplyPayload(
      { disposition: "expected_behavior", reportedByUserId: "reporter-1" },
      "🐛 Validation finished: this matches the intended behavior.",
      2_000,
    );

    expect(payload.content).not.toContain("<@reporter-1>");
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
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
    taskType: "code_update",
    title: "Improve thing",
    request: "please improve thing",
    requestedBy: "kartik",
    status: "running",
    backend: "kubernetes-sandbox",
    currentStep: "sandbox_running",
    statusMessage: "Kubernetes sandbox is running the task.",
    branchName: null,
    prUrl: null,
    draft: null,
    verifyPassed: null,
    error: null,
    createdAt: now,
    startedAt: now,
    cancelledAt: null,
    completedAt: null,
    notifiedAt: null,
    notificationError: null,
    progressUpdatedAt: now,
    lastRenderedSignature: null,
    lastRenderedAt: null,
    terminalRenderedAt: null,
    updatedAt: now,
    ...overrides
  };
}

function taskEvent(overrides: Partial<TaskEvent> & { step?: string } = {}): TaskEvent {
  const step = overrides.step;
  return {
    id: 1,
    taskId: "task-1",
    traceId: "trace-1",
    eventName: "task.progress",
    level: "info",
    summary: "Progress event.",
    metadata: step ? { step } : {},
    createdAt: new Date("2026-06-30T12:00:00Z"),
    ...overrides
  };
}
