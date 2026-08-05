import { describe, expect, it, vi } from "vitest";
import type { ImprovementReporterUpdate } from "../../src/db/types.js";
import {
  handleImprovementClarificationReply,
  renderImprovementReporterUpdate,
} from "../../src/discord/improvementReporterUpdates.js";

describe("private improvement reporter updates", () => {
  it("asks the exact clarification and explains the reply contract", () => {
    const rendered = renderImprovementReporterUpdate(update({
      caseStatus: "needs_evidence",
      clarificationTaskId: "task-1",
      clarificationQuestion: "Should the total include tax?",
    }));
    expect(rendered.content).toContain("Should the total include tax?");
    expect(rendered.content).toContain("Reply directly to this message");
  });

  it("renders withdrawal, progress, and verified resolution from the case lifecycle", () => {
    expect(renderImprovementReporterUpdate(update({ signalActive: false })).content).toContain("stopped tracking");
    expect(renderImprovementReporterUpdate(update({ caseStatus: "in_progress" })).content).toContain("fix is in progress");
    expect(renderImprovementReporterUpdate(update({ caseStatus: "resolved" })).content).toContain("verified in production");
  });

  it("turns only a direct DM reply into evidence and wakes reassessment", async () => {
    const answerImprovementReporterClarification = vi.fn(async () => ({ updateId: "update-1", caseId: "case-1", signalId: "signal-answer" }));
    const enqueueImprovementReconciliation = vi.fn(async () => "job-1");
    const handled = await handleImprovementClarificationReply({
      repo: { answerImprovementReporterClarification } as never,
      jobs: { enqueueImprovementReconciliation },
    }, {
      inGuild: () => false,
      author: { id: "member-1", bot: false },
      reference: { messageId: "question-message" },
      channelId: "dm-channel",
      content: "Yes, include tax.",
    } as never);

    expect(handled).toBe(true);
    expect(answerImprovementReporterClarification).toHaveBeenCalledWith({
      reporterId: "member-1",
      dmChannelId: "dm-channel",
      dmMessageId: "question-message",
      answer: "Yes, include tax.",
    });
    expect(enqueueImprovementReconciliation).toHaveBeenCalledOnce();
  });

  it("ignores unrelated DMs", async () => {
    const answerImprovementReporterClarification = vi.fn();
    const handled = await handleImprovementClarificationReply({
      repo: { answerImprovementReporterClarification } as never,
    }, {
      inGuild: () => false,
      author: { id: "member-1", bot: false },
      reference: null,
      channelId: "dm-channel",
      content: "hello",
    } as never);
    expect(handled).toBe(false);
    expect(answerImprovementReporterClarification).not.toHaveBeenCalled();
  });
});

function update(overrides: Partial<ImprovementReporterUpdate> = {}): ImprovementReporterUpdate {
  const now = new Date("2026-08-05T12:00:00.000Z");
  return {
    updateId: "update-1",
    caseId: "case-1",
    signalId: "signal-1",
    reporterId: "member-1",
    signalActive: true,
    caseStatus: "open",
    caseResolution: null,
    clarificationTaskId: null,
    clarificationQuestion: null,
    clarificationAnswer: null,
    answerSignalId: null,
    dmChannelId: "dm-channel",
    dmMessageId: "dm-message",
    lastRenderedSignature: null,
    lastRenderedAt: null,
    deliveryAttempts: 0,
    lastDeliveryError: null,
    nextDeliveryAt: null,
    deliveryAbandonedAt: null,
    clarificationRequestedAt: null,
    answeredAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
