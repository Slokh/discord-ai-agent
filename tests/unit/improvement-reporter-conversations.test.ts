import { describe, expect, it, vi } from "vitest";
import type { ImprovementReporterConversation } from "../../src/db/types.js";
import {
  handleImprovementClarificationReply,
  resolveImprovementReporterThread,
  renderImprovementReporterConversation,
} from "../../src/discord/improvementReporterConversations.js";

describe("improvement reporter conversations", () => {
  it("asks the exact clarification as a natural conversation turn", () => {
    const rendered = renderImprovementReporterConversation(conversation({
      caseStatus: "needs_evidence",
      clarificationTaskId: "task-1",
      clarificationQuestion: "Should the total include tax?",
    }));
    expect(rendered.content).toContain("Should the total include tax?");
    expect(rendered.content).toContain("Reply here with the answer");
  });

  it("renders withdrawal, progress, and verified resolution from the case lifecycle", () => {
    expect(renderImprovementReporterConversation(conversation({ signalActive: false })).content).toContain("stopped tracking");
    expect(renderImprovementReporterConversation(conversation({ caseStatus: "in_progress" })).content).toContain("fix is in progress");
    expect(renderImprovementReporterConversation(conversation({ caseStatus: "resolved" })).content).toContain("verified in production");
  });

  it("accepts a natural guild-thread follow-up without requiring a message reply", async () => {
    const answerImprovementReporterClarification = vi.fn(async () => ({ conversationId: "conversation-1", caseId: "case-1", signalId: "answer-1" }));
    const enqueueImprovementReconciliation = vi.fn(async () => "job-1");
    const handled = await handleImprovementClarificationReply({
      repo: { answerImprovementReporterClarification } as never,
      jobs: { enqueueImprovementReconciliation },
    }, {
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "thread-1",
      channel: { isThread: () => true },
      id: "follow-up-1",
      author: { id: "member-1", bot: false },
      reference: null,
      content: "Yes, include tax.",
    } as never);

    expect(handled).toBe(true);
    expect(answerImprovementReporterClarification).toHaveBeenCalledWith({
      authorId: "member-1",
      guildId: "guild-1",
      channelId: "thread-1",
      messageId: "follow-up-1",
      referencedMessageId: null,
      answer: "Yes, include tax.",
    });
    expect(enqueueImprovementReconciliation).toHaveBeenCalledOnce();
  });

  it("requires an explicit reply for the fallback DM", async () => {
    const answerImprovementReporterClarification = vi.fn(async () => ({ conversationId: "conversation-1", caseId: "case-1", signalId: "answer-1" }));
    const handled = await handleImprovementClarificationReply({
      repo: { answerImprovementReporterClarification } as never,
    }, {
      inGuild: () => false,
      channelId: "dm-channel",
      id: "dm-answer",
      author: { id: "member-1", bot: false },
      reference: { messageId: "question-message" },
      content: "Yes, include tax.",
    } as never);
    expect(handled).toBe(true);
    expect(answerImprovementReporterClarification).toHaveBeenCalledWith(expect.objectContaining({
      guildId: null,
      channelId: "dm-channel",
      messageId: "dm-answer",
      referencedMessageId: "question-message",
    }));
  });

  it("creates a public thread from the reported source message", async () => {
    const thread = { id: "thread-1", isThread: () => true };
    const startThread = vi.fn(async () => thread);
    const sourceMessage = {
      inGuild: () => true,
      guildId: "guild-1",
      thread: null,
      hasThread: false,
      startThread,
    };
    const client = {
      channels: { fetch: vi.fn(async () => ({ isThread: () => false, messages: { fetch: vi.fn(async () => sourceMessage) } })) },
    };
    await expect(resolveImprovementReporterThread(client as never, conversation())).resolves.toBe(thread);
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ name: "🐛 report follow-up" }));
  });

  it("uses DM fallback when the report was made inside an existing thread", async () => {
    const client = { channels: { fetch: vi.fn(async () => ({ isThread: () => true })) } };
    await expect(resolveImprovementReporterThread(client as never, conversation())).resolves.toBeNull();
  });
});

function conversation(overrides: Partial<ImprovementReporterConversation> = {}): ImprovementReporterConversation {
  const now = new Date("2026-08-05T12:00:00.000Z");
  return {
    conversationId: "conversation-1",
    caseId: "case-1",
    guildId: "guild-1",
    sourceChannelId: "channel-1",
    sourceMessageId: "message-1",
    reporterId: "member-1",
    signalActive: true,
    caseStatus: "open",
    caseResolution: null,
    deliveryKind: null,
    deliveryChannelId: null,
    deliveryMessageId: null,
    clarificationTaskId: null,
    clarificationQuestion: null,
    clarificationAnswer: null,
    answerSignalId: null,
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
