import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/observability/redaction.js";
import { extractDiscordMessageId, summaryFromTask } from "../../src/observability/runs.js";
import type { AgentTaskRecord } from "../../src/db/repositories.js";

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
    const task: AgentTaskRecord = {
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
      updatedAt: completedAt
    };

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
});
