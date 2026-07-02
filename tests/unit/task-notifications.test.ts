import { describe, expect, it } from "vitest";
import { agentTaskRunConsoleUrl, renderAgentTaskMessage } from "../../src/discord/taskNotifications.js";
import type { AppConfig } from "../../src/config/env.js";
import type { AgentTaskRecord } from "../../src/db/repositories.js";

describe("agent task Discord notifications", () => {
  it("includes the run console link when a public control UI URL is configured", () => {
    const task = agentTask({ status: "running", taskId: "task/with space" });
    const config = { controlUi: { publicUrl: "https://agent.example" } } as AppConfig;
    const url = agentTaskRunConsoleUrl(config, task.taskId);

    expect(url).toBe("https://agent.example/runs/task%2Fwith%20space");
    expect(renderAgentTaskMessage(task, undefined, undefined, { runConsoleUrl: url }).content).toContain(`Run console: ${url}`);
  });

  it("renders a concise live status message while a task is running", () => {
    const task = agentTask({ status: "running", statusMessage: "Preparing the sandbox." });

    expect(renderAgentTaskMessage(task).content).toBe(
      ["Preparing the sandbox.", "", "Task: `Improve thing`", "Status: `running`", "Task ID: `task-1`"].join("\n")
    );
  });

  it("renders no-diff terminal failures bluntly", () => {
    const task = agentTask({
      status: "no_changes",
      currentStep: "no_changes",
      statusMessage: "Agent task produced no diff after Codex app-server recovery attempts; no PR will be opened.",
      error: "Agent task produced no diff after Codex app-server recovery attempts; no PR will be opened.",
      completedAt: new Date("2026-06-30T12:01:00Z")
    });

    expect(renderAgentTaskMessage(task).content).toContain("No PR opened: the coding agent did not produce a code diff.");
  });

  it("omits the run console line when no public control UI URL is configured", () => {
    const task = agentTask({ status: "queued" });

    expect(agentTaskRunConsoleUrl({ controlUi: { publicUrl: null } } as AppConfig, task.taskId)).toBeNull();
    expect(renderAgentTaskMessage(task).content).not.toContain("Run console:");
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
