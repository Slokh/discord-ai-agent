import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/observability/redaction.js";
import { diagnosticsForRun, extractDiscordMessageId, relatedRunSummaries, summaryFromTask } from "../../src/observability/runs.js";
import type { AgentTaskRecord } from "../../src/db/repositories.js";
import type { RunEvent, RunSummary } from "../../src/observability/runs.js";

describe("observability redaction", () => {
  it("redacts common secret shapes before artifact persistence", () => {
    const fakeOpenRouterKey = ["sk-or-v1", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const result = redactSensitiveText(`OPENROUTER_API_KEY=${fakeOpenRouterKey} and Bearer secret-token-value-1234567890`);

    expect(result.text).toContain("OPENROUTER_API_KEY=[REDACTED]");
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("sk-or-v1");
    expect(result.redactionCount).toBeGreaterThanOrEqual(2);
  });
});

describe("run summaries", () => {
  it("extracts Discord message ids from links and pasted text", () => {
    expect(extractDiscordMessageId("1521541635580756031")).toBe("1521541635580756031");
    expect(extractDiscordMessageId("https://discord.com/channels/111111111111111111/222222222222222222/1521541635580756031")).toBe(
      "1521541635580756031"
    );
    expect(extractDiscordMessageId("message: https://discord.com/channels/guild/channel/1521541635580756031 please")).toBe("1521541635580756031");
    expect(extractDiscordMessageId("not a message")).toBeNull();
  });

  it("derives codegen run summaries from legacy task rows", () => {
    const createdAt = new Date("2026-06-30T12:00:00Z");
    const completedAt = new Date("2026-06-30T12:02:00Z");
    const task = agentTaskRecord({ createdAt, startedAt: createdAt, completedAt, updatedAt: completedAt });

    expect(summaryFromTask(task)).toEqual(
      expect.objectContaining({
        runId: "task-1",
        kind: "codegen",
        status: "succeeded",
        durationMs: 120_000,
        links: expect.objectContaining({ pullRequest: "https://github.com/example/repo/pull/1" })
      })
    );
  });

  it("derives related child runs from the shared trace while excluding the selected task", () => {
    const selected = agentTaskRecord({ taskId: "task-selected", traceId: "trace-1" });
    const child = agentTaskRecord({ taskId: "task-child", traceId: "trace-1", title: "Child task", status: "running" });

    expect(relatedRunSummaries({ task: selected, relatedProcessRuns: [], relatedTasks: [selected, child] })).toEqual([
      expect.objectContaining({
        runId: "task-child",
        kind: "codegen",
        status: "running",
        title: "Child task"
      })
    ]);
  });

  it("diagnoses active codegen runs as inspectable live progress", () => {
    const run = codegenRun({ status: "running", currentStep: "codex_app_server_attempt_1" });

    expect(diagnosticsForRun(run, [], [])).toContain("Coding agent is running; inspect the latest harness, tool, and command events for live progress.");
  });

  it("diagnoses codegen runs that finished without a diff", () => {
    const run = codegenRun({ status: "no_changes", summary: "Agent task produced no diff." });
    const events = [
      runEvent({
        name: "task.progress",
        summary: "Codex app-server attempt 1 finished without a code diff.",
        metadata: { step: "codex_app_server_attempt_1_no_diff" }
      })
    ];

    expect(diagnosticsForRun(run, [], events)).toContain("Coding agent finished without leaving a code diff.");
  });
});

function codegenRun(overrides: Partial<RunSummary> = {}): RunSummary {
  const now = new Date("2026-06-30T12:00:00Z");
  return {
    runId: "task-1",
    traceId: "trace-1",
    kind: "codegen",
    status: "running",
    title: "Test task",
    summary: null,
    requester: "kartik",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    messageId: null,
    source: "agent_task",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    durationMs: null,
    currentStep: "running",
    bottleneck: null,
    links: {},
    metadata: {},
    ...overrides
  };
}

function runEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: "event-1",
    source: "task",
    level: "info",
    name: "task.progress",
    summary: null,
    createdAt: new Date("2026-06-30T12:00:30Z"),
    durationMs: null,
    metadata: {},
    ...overrides
  };
}

function agentTaskRecord(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  const createdAt = new Date("2026-06-30T12:00:00Z");
  const completedAt = new Date("2026-06-30T12:02:00Z");
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
    title: "Fix title",
    request: "please fix title",
    requestedBy: "kartik",
    status: "succeeded",
    backend: "kubernetes-sandbox",
    currentStep: "done",
    statusMessage: "Opened pull request.",
    branchName: "branch",
    prUrl: "https://github.com/example/repo/pull/1",
    draft: false,
    verifyPassed: true,
    error: null,
    createdAt,
    startedAt: createdAt,
    cancelledAt: null,
    completedAt,
    notifiedAt: null,
    notificationError: null,
    progressUpdatedAt: completedAt,
    lastRenderedSignature: null,
    lastRenderedAt: null,
    terminalRenderedAt: null,
    updatedAt: completedAt,
    ...overrides
  };
}
