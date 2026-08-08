import type { ImprovementContractCheck } from "../db/types.js";
import { improvementCheckHash, improvementProofAdapterForCheck } from "../improvements/proofAdapters.js";

type PrivateReplayReplyContextMessage = {
  messageId: string;
  channelId: string;
  content: string;
  authorIsBot: boolean;
  attachmentSummaries: string[];
  attachments: unknown[];
  [key: string]: unknown;
};

type PrivateReplayReplyContext = PrivateReplayReplyContextMessage & {
  rootMessageId: string;
  chain: PrivateReplayReplyContextMessage[];
};

type PrivateReplayTurnEnvelope = {
  requestKind?: unknown;
  guildId: string;
  channelId: string;
  userId: string;
  visibleChannelIds: string[];
  replyContext: unknown;
  requestAttachments: unknown;
  requestEmbeds?: unknown;
  interaction?: unknown;
};

export type ImprovementReplayCheckResult = {
  checkHash: string;
  status: "passed" | "failed" | "inconclusive";
};

export function improvementContractAssertions(checks: readonly ImprovementContractCheck[]) {
  return {
    expectedTools: checks.flatMap((check) => check.kind === "tool" && check.expectation === "required" ? [check.name] : []),
    forbiddenTools: checks.flatMap((check) => check.kind === "tool" && check.expectation === "forbidden" ? [check.name] : []),
    mustContain: checks.flatMap((check) => check.kind === "answer_text" && check.expectation === "required" ? [check.value] : []),
    mustNotContain: checks.flatMap((check) => check.kind === "answer_text" && check.expectation === "forbidden" ? [check.value] : []),
    expectedRuntimeEvents: checks.flatMap((check) => check.kind === "runtime_event" && check.expectation === "required" ? [check.name] : []),
    forbiddenRuntimeEvents: checks.flatMap((check) => check.kind === "runtime_event" && check.expectation === "forbidden" ? [check.name] : []),
  };
}

export function improvementContractReplaySkipReason(input: {
  hasAssertion: boolean;
  hasReplayScope: boolean;
  hasReplayableContext: boolean;
}): string | null {
  if (!input.hasAssertion) return "The contract has no private-replay assertion.";
  if (!input.hasReplayScope) return "The original requester's visible-channel scope is unavailable, so this case cannot be replayed faithfully.";
  if (!input.hasReplayableContext) return "The original request depends on Discord context that the private replay cannot reproduce faithfully.";
  return null;
}

export function hasFaithfulPrivateReplayContext(input: {
  requestKind?: unknown;
  replyContext: unknown;
  requestAttachments: unknown;
  requestEmbeds?: unknown;
  interaction?: unknown;
}): boolean {
  return input.requestKind === "message"
    && (input.replyContext == null || isRetainedReplyContext(input.replyContext))
    && !nonEmptyArray(input.requestAttachments)
    && !nonEmptyArray(input.requestEmbeds)
    && input.interaction == null;
}

export function privateReplayReplyContextFromEnvelope(
  envelope: PrivateReplayTurnEnvelope,
  scope: { guildId: string; channelId: string; userId: string; visibleChannelIds: readonly string[] },
): PrivateReplayReplyContext | undefined {
  if (envelope.guildId !== scope.guildId || envelope.channelId !== scope.channelId || envelope.userId !== scope.userId) {
    throw new Error("Retained private-replay context does not match the requested Discord scope.");
  }
  if (!sameStrings(envelope.visibleChannelIds, scope.visibleChannelIds)) {
    throw new Error("Retained private-replay context does not match the requested visible-channel scope.");
  }
  if (!hasFaithfulPrivateReplayContext(envelope)) {
    throw new Error("Retained Discord context cannot be replayed faithfully.");
  }
  return envelope.replyContext == null ? undefined : isRetainedReplyContext(envelope.replyContext)
    ? envelope.replyContext
    : undefined;
}

/** Produces content-free, per-check conclusions from one retained private replay. */
export function improvementContractReplayResults(
  checks: readonly ImprovementContractCheck[],
  output: {
    answer: string;
    observedTools: readonly string[];
    eventNames: readonly string[];
    available: boolean;
  },
): ImprovementReplayCheckResult[] {
  const observedTools = new Set(output.observedTools);
  const eventNames = new Set(output.eventNames);
  const answer = output.answer.toLowerCase();
  return checks.flatMap((check): ImprovementReplayCheckResult[] => {
    if (improvementProofAdapterForCheck(check)?.id !== "private_replay") return [];
    if (!output.available) return [{ checkHash: improvementCheckHash(check), status: "inconclusive" }];
    let passed = false;
    if (check.kind === "tool") {
      const observed = observedTools.has(check.name);
      passed = check.expectation === "required" ? observed : !observed;
    } else if (check.kind === "answer_text") {
      const contains = answer.includes(check.value.toLowerCase());
      passed = check.expectation === "required" ? contains : !contains;
    } else if (check.kind === "runtime_event") {
      const observed = eventNames.has(check.name);
      passed = check.expectation === "required" ? observed : !observed;
    }
    return [{ checkHash: improvementCheckHash(check), status: passed ? "passed" : "failed" }];
  });
}

function nonEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function isRetainedReplyContext(value: unknown): value is PrivateReplayReplyContext {
  if (!isReplyContextMessage(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.rootMessageId === "string"
    && Array.isArray(record.chain)
    && record.chain.every(isReplyContextMessage);
}

function isReplyContextMessage(value: unknown): value is PrivateReplayReplyContextMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.messageId === "string"
    && typeof record.channelId === "string"
    && typeof record.content === "string"
    && typeof record.authorIsBot === "boolean"
    && Array.isArray(record.attachmentSummaries)
    && record.attachmentSummaries.every((item) => typeof item === "string")
    && Array.isArray(record.attachments);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
