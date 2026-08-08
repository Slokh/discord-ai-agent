import { describe, expect, it } from "vitest";
import type { ImprovementContractCheck } from "../../src/db/types.js";
import { improvementFingerprint, normalizeImprovementTitle } from "../../src/improvements/coalescing.js";
import { assertActionableContract, assertImprovementTransition, improvementChecksExecutable } from "../../src/improvements/policy.js";
import {
  hasFaithfulPrivateReplayContext,
  improvementContractAssertions,
  improvementContractReplayResults,
  improvementContractReplaySkipReason,
  privateReplayReplyContextFromEnvelope,
} from "../../src/observability/improvementContractReplay.js";
import type { AgentRuntimeTurnEnvelope } from "../../src/agent/runtimeEnvelope.js";

describe("improvement domain", () => {
  it("coalesces only stable normalized fingerprint inputs", () => {
    const base = { guildId: "guild", scope: "guild", privacy: "private" as const, owningDomain: "Agent Replies", classification: "defect" as const };
    expect(improvementFingerprint({ ...base, summary: "Tool timed out 123456789" }))
      .toBe(improvementFingerprint({ ...base, summary: "tool timed out 987654321" }));
    expect(improvementFingerprint({ ...base, summary: "Tool timed out", stableCode: "timeout:history" }))
      .not.toBe(improvementFingerprint({ ...base, summary: "Tool timed out", stableCode: "timeout:web" }));
    expect(normalizeImprovementTitle("  a   useful report  ")).toBe("a useful report");
  });

  it("enforces evidence-gated lifecycle transitions and executable contracts", () => {
    expect(() => assertImprovementTransition("open", "resolved")).toThrow(/Invalid improvement/);
    expect(() => assertImprovementTransition("verifying", "resolved")).not.toThrow();
    expect(improvementChecksExecutable([{ kind: "manual", description: "look" }])).toBe(false);
    expect(() => assertActionableContract([{ kind: "manual", description: "look" }])).toThrow(/registered proof adapter/);
    expect(() => assertActionableContract([{ kind: "test", reference: "unknown-gate" }])).toThrow(/registered proof adapter/);
    expect(() => assertActionableContract([{ kind: "tool", name: "inspectDiscordFile", expectation: "required" }])).toThrow(/registered proof adapter/);
    expect(() => assertActionableContract([{ kind: "tool", name: "transferWalletFunds", expectation: "required" }])).toThrow(/registered proof adapter/);
    expect(() => assertActionableContract([{ kind: "tool", name: "transferWalletFunds", expectation: "forbidden" }])).toThrow(/registered proof adapter/);
    expect(() => assertActionableContract([{ kind: "test", reference: "release-verify" }])).not.toThrow();
  });

  it("projects accepted contracts into private prompt-eval assertions", () => {
    const assertions = improvementContractAssertions([
      { kind: "tool", name: "searchDiscordHistory", expectation: "required" },
      { kind: "answer_text", value: "source", expectation: "required" },
      { kind: "runtime_event", name: "agent.execution.failed", expectation: "forbidden" },
      { kind: "test", reference: "release-verify" },
    ]);
    expect(assertions).toEqual({
      expectedTools: ["searchDiscordHistory"],
      forbiddenTools: [],
      mustContain: ["source"],
      mustNotContain: [],
      expectedRuntimeEvents: [],
      forbiddenRuntimeEvents: ["agent.execution.failed"],
    });
    expect(improvementContractReplaySkipReason({ hasAssertion: true, hasReplayScope: true, hasReplayableContext: true })).toBeNull();
    expect(improvementContractReplaySkipReason({ hasAssertion: false, hasReplayScope: true, hasReplayableContext: true })).toMatch(/no private-replay assertion/);
    expect(improvementContractReplaySkipReason({ hasAssertion: true, hasReplayScope: true, hasReplayableContext: false })).toMatch(/cannot reproduce faithfully/);
  });

  it("replays text turns whose bounded Discord reply context can be reconstructed", () => {
    const textTurn = {
      requestKind: "message",
      replyContext: null,
      requestAttachments: [],
      requestEmbeds: [],
      interaction: null,
    };
    expect(hasFaithfulPrivateReplayContext(textTurn)).toBe(true);
    const replyContext = {
      messageId: "parent",
      rootMessageId: "root",
      channelId: "channel",
      guildId: "guild",
      authorId: "bot",
      authorDisplayName: "Bot",
      authorIsBot: true,
      content: "Earlier bounded context",
      attachmentSummaries: [],
      attachments: [],
      createdAt: null,
      url: null,
      chain: [],
    };
    expect(hasFaithfulPrivateReplayContext({ ...textTurn, replyContext })).toBe(true);
    expect(hasFaithfulPrivateReplayContext({ ...textTurn, replyContext: { messageId: "parent" } })).toBe(false);
    expect(hasFaithfulPrivateReplayContext({ ...textTurn, requestAttachments: [{ id: "file" }] })).toBe(false);
    expect(hasFaithfulPrivateReplayContext({ ...textTurn, requestEmbeds: [{ url: "https://example.com" }] })).toBe(false);
    expect(hasFaithfulPrivateReplayContext({ ...textTurn, interaction: { customId: "button" } })).toBe(false);
    expect(hasFaithfulPrivateReplayContext({ ...textTurn, requestKind: "scheduled" })).toBe(false);

    const envelope = {
      ...textTurn,
      requestKind: "message" as const,
      schemaVersion: 2,
      source: "discord",
      requestId: "request",
      threadKey: "discord:guild:channel",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "User",
      botUserId: "bot",
      botRoleIds: [],
      text: "follow up",
      rawContent: "follow up",
      discordUrl: "https://discord.com/channels/guild/channel/request",
      messageCreatedAt: "2026-08-08T00:00:00.000Z",
      visibleChannelIds: ["channel", "other"],
      mentionedUserIds: [],
      mentionedChannelIds: [],
      replyContext,
      sessionMessages: [],
      delivery: { statusChannelId: null, statusMessageId: null },
      createdAt: "2026-08-08T00:00:00.000Z",
    } satisfies AgentRuntimeTurnEnvelope;
    expect(privateReplayReplyContextFromEnvelope(envelope, {
      guildId: "guild", channelId: "channel", userId: "user", visibleChannelIds: ["other", "channel"],
    })).toEqual(replyContext);
    expect(() => privateReplayReplyContextFromEnvelope(envelope, {
      guildId: "guild", channelId: "channel", userId: "other-user", visibleChannelIds: ["channel", "other"],
    })).toThrow(/does not match/);
  });

  it("derives content-free pass and failure conclusions for every private replay check kind", () => {
    const checks: ImprovementContractCheck[] = [
      { kind: "tool", name: "searchDiscordHistory", expectation: "required" },
      { kind: "tool", name: "getDiscordStats", expectation: "forbidden" },
      { kind: "answer_text", value: "source", expectation: "required" },
      { kind: "answer_text", value: "secret", expectation: "forbidden" },
      { kind: "runtime_event", name: "agent.execution.succeeded", expectation: "required" },
      { kind: "runtime_event", name: "agent.execution.failed", expectation: "forbidden" },
      { kind: "test", reference: "release-verify" },
    ];

    expect(improvementContractReplayResults(checks, {
      answer: "The SOURCE is linked.",
      observedTools: ["searchDiscordHistory"],
      eventNames: ["agent.execution.succeeded"],
      available: true,
    }).map((result) => result.status)).toEqual(Array(6).fill("passed"));

    expect(improvementContractReplayResults(checks, {
      answer: "The secret is unavailable.",
      observedTools: ["getDiscordStats"],
      eventNames: ["agent.execution.failed"],
      available: true,
    }).map((result) => result.status)).toEqual(Array(6).fill("failed"));
  });

  it("marks every private replay check inconclusive when replay evidence is unavailable", () => {
    const checks: ImprovementContractCheck[] = [
      { kind: "tool", name: "searchDiscordHistory", expectation: "required" },
      { kind: "answer_text", value: "source", expectation: "required" },
      { kind: "runtime_event", name: "agent.execution.succeeded", expectation: "required" },
      { kind: "database_invariant", reference: "release-db-verify" },
    ];
    expect(improvementContractReplayResults(checks, {
      answer: "",
      observedTools: [],
      eventNames: [],
      available: false,
    }).map((result) => result.status)).toEqual(Array(3).fill("inconclusive"));
  });
});
