import { describe, expect, it, vi } from "vitest";
import type { ImprovementReporterConversation } from "../../src/db/types.js";
import {
  handleImprovementClarificationReply,
  replyToOriginalReport,
  renderImprovementReporterConversation,
  shouldDeliverImprovementReporterConversation,
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

  it("renders only the verified production resolution", () => {
    expect(renderImprovementReporterConversation(conversation({ caseStatus: "resolved" })).content).toContain("verified in production");
  });

  it("delivers only reporter questions and the final deployed resolution", () => {
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "open" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "needs_evidence" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "actionable" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "dismissed" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({
      caseStatus: "needs_evidence",
      clarificationQuestion: "What result did you expect?",
    }))).toBe(true);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "in_progress" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "verifying" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "resolved" }))).toBe(true);
    expect(shouldDeliverImprovementReporterConversation(conversation({
      caseStatus: "dismissed",
      signalActive: false,
      deliveryKind: "channel",
      deliveryChannelId: "channel-1",
      deliveryMessageId: "message-1",
    }))).toBe(false);
  });

  it("accepts the reporter's explicit reply to the channel clarification", async () => {
    const answerImprovementReporterClarification = vi.fn(async () => ({ conversationId: "conversation-1", caseId: "case-1", signalId: "answer-1" }));
    const enqueueImprovementReconciliation = vi.fn(async () => "job-1");
    const handled = await handleImprovementClarificationReply({
      repo: { answerImprovementReporterClarification } as never,
      jobs: { enqueueImprovementReconciliation },
    }, {
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "channel-1",
      id: "follow-up-1",
      author: { id: "member-1", bot: false },
      reference: { messageId: "question-message" },
      content: "Yes, include tax.",
    } as never);

    expect(handled).toBe(true);
    expect(answerImprovementReporterClarification).toHaveBeenCalledWith({
      authorId: "member-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "follow-up-1",
      referencedMessageId: "question-message",
      answer: "Yes, include tax.",
    });
    expect(enqueueImprovementReconciliation).toHaveBeenCalledOnce();
  });

  it("ignores DMs and non-reply channel messages", async () => {
    const answerImprovementReporterClarification = vi.fn();
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
    expect(handled).toBe(false);
    expect(answerImprovementReporterClarification).not.toHaveBeenCalled();
  });

  it("mentions the reporter in an explicit reply to the original report", async () => {
    const reply = vi.fn(async () => ({ id: "question-message", channelId: "channel-1" }));
    const fetchMessage = vi.fn(async () => ({ inGuild: () => true, guildId: "guild-1", reply }));
    const client = { channels: { fetch: vi.fn(async () => ({ messages: { fetch: fetchMessage } })) } };

    await expect(replyToOriginalReport(client as never, conversation(), "What result did you expect?")).resolves.toMatchObject({
      kind: "channel",
      message: { id: "question-message", channelId: "channel-1" },
    });
    expect(client.channels.fetch).toHaveBeenCalledWith("channel-1");
    expect(fetchMessage).toHaveBeenCalledWith("message-1");
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "<@member-1> What result did you expect?",
      allowedMentions: { parse: [], users: ["member-1"] },
    }));
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
