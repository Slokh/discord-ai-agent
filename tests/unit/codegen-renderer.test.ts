import { describe, expect, it } from "vitest";
import type { AgentCodegenJobRecord } from "../../src/db/repositories.js";
import { renderCodegenJobMessage } from "../../src/discord/codegenRenderer.js";

describe("codegen Discord renderer", () => {
  it("renders nonterminal codegen progress without queue jargon", () => {
    const rendered = renderCodegenJobMessage(
      job({
        status: "queued",
        statusMessage: "Waiting for the codegen worker to pick this up."
      })
    );

    expect(rendered.terminal).toBe(false);
    expect(rendered.content).toContain("Preparing the code change.");
    expect(rendered.content).not.toContain("Waiting for the codegen worker");
    expect(rendered.content).toContain("Update: `calendar-integration`");
    expect(rendered.content).toContain("Request ID: `message-1`");
  });

  it("renders successful draft pull requests", () => {
    const rendered = renderCodegenJobMessage(
      job({
        status: "succeeded",
        prUrl: "https://github.com/example/repo/pull/7",
        draft: true,
        verifyPassed: false
      })
    );

    expect(rendered.terminal).toBe(true);
    expect(rendered.content).toBe("Done: https://github.com/example/repo/pull/7 It opened as a draft because verification did not fully pass.");
  });

  it("renders no-change and failed terminal states", () => {
    expect(renderCodegenJobMessage(job({ status: "no_changes" })).content).toContain("did not produce a code diff");
    expect(renderCodegenJobMessage(job({ status: "failed", error: "Codex stopped early" })).content).toBe(
      "I tried to make that change, but codegen failed: Codex stopped early"
    );
  });
});

function job(overrides: Partial<AgentCodegenJobRecord> = {}): AgentCodegenJobRecord {
  const now = new Date("2026-06-30T00:00:00Z");
  return {
    requestId: "message-1",
    pgBossJobId: "job-1",
    traceId: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    threadKey: "discord:guild-1:channel-1:message-1",
    replyChannelId: "channel-1",
    replyMessageId: "reply-1",
    updateName: "calendar-integration",
    request: "add a calendar integration",
    requestedBy: "User (user-1)",
    status: "running",
    backend: "test",
    currentStep: "codex",
    statusMessage: "Codex is working.",
    branchName: null,
    prUrl: null,
    draft: null,
    verifyPassed: null,
    error: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    progressUpdatedAt: now,
    lastRenderedSignature: null,
    lastRenderedAt: null,
    terminalRenderedAt: null,
    updatedAt: now,
    ...overrides
  };
}
