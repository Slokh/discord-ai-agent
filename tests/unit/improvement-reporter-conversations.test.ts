import { describe, expect, it, vi } from "vitest";
import type { ImprovementReporterConversation } from "../../src/db/types.js";
import {
  handleImprovementClarificationReply,
  resolveImprovementReporterThread,
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

  it("renders withdrawal, progress, and verified resolution from the case lifecycle", () => {
    expect(renderImprovementReporterConversation(conversation({ signalActive: false })).content).toContain("stopped tracking");
    expect(renderImprovementReporterConversation(conversation({ caseStatus: "in_progress" })).content).toContain("fix is in progress");
    expect(renderImprovementReporterConversation(conversation({ caseStatus: "resolved" })).content).toContain("verified in production");
  });

  it("opens a conversation only for reporter input or repair work, then keeps it alive", () => {
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "open" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "needs_evidence" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "actionable" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "dismissed" }))).toBe(false);
    expect(shouldDeliverImprovementReporterConversation(conversation({
      caseStatus: "needs_evidence",
      clarificationQuestion: "What result did you expect?",
    }))).toBe(true);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "in_progress" }))).toBe(true);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "verifying" }))).toBe(true);
    expect(shouldDeliverImprovementReporterConversation(conversation({ caseStatus: "resolved" }))).toBe(true);
    expect(shouldDeliverImprovementReporterConversation(conversation({
      caseStatus: "dismissed",
      signalActive: false,
      deliveryKind: "thread",
      deliveryChannelId: "thread-1",
      deliveryMessageId: "message-1",
    }))).toBe(true);
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

  it("creates a standalone public thread in the configured bot channel", async () => {
    const thread = { id: "thread-1", isThread: () => true };
    const create = vi.fn(async () => thread);
    const client = {
      channels: { fetch: vi.fn(async () => ({
        type: 0,
        guildId: "guild-1",
        guild: { members: { fetch: vi.fn(async () => ({ id: "member-1" })) } },
        permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
        threads: { create },
      })) },
    };
    await expect(resolveImprovementReporterThread(client as never, conversation(), "hub-channel")).resolves.toBe(thread);
    expect(client.channels.fetch).toHaveBeenCalledWith("hub-channel");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "🐛 report follow-up",
      type: 11,
      autoArchiveDuration: 60,
    }));
  });

  it("declines hub delivery when the channel is unconfigured or outside the report guild", async () => {
    const fetch = vi.fn(async () => ({ type: 0, guildId: "other-guild" }));
    const client = { channels: { fetch } };
    await expect(resolveImprovementReporterThread(client as never, conversation(), null)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await expect(resolveImprovementReporterThread(client as never, conversation(), "hub-channel")).resolves.toBeNull();
  });

  it("requires the reporter to view the hub and send in its threads", async () => {
    const create = vi.fn();
    const client = {
      channels: { fetch: vi.fn(async () => ({
        type: 0,
        guildId: "guild-1",
        guild: { members: { fetch: vi.fn(async () => ({ id: "member-1" })) } },
        permissionsFor: vi.fn(() => ({ has: vi.fn(() => false) })),
        threads: { create },
      })) },
    };

    await expect(resolveImprovementReporterThread(client as never, conversation(), "hub-channel")).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
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
