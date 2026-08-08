import { type Client, type Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, ImprovementReporterConversation } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import { durationMs, logger } from "../util/logger.js";
import { discordReply } from "./api.js";
import { persistDiscordMessage } from "./messagePersistence.js";

const DEFAULT_POLL_MS = 2_000;
const RENDER_LIMIT = 50;

export type ImprovementReporterNotifierRuntime = { stop: () => void };

/** Replies to the original report only for an exact clarification or deployed resolution. */
export function startImprovementReporterNotifier(input: {
  client: Client;
  repo: DiscordAiAgentRepository;
  config: AppConfig;
  pollMs?: number;
}): ImprovementReporterNotifierRuntime {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = Date.now();
    try {
      if (!input.client.isReady()) return;
      const conversations = await input.repo.listRenderableImprovementReporterConversations(RENDER_LIMIT);
      for (const conversation of conversations) {
        if (!shouldDeliverImprovementReporterConversation(conversation)) continue;
        await deliverReporterConversation(input, conversation).catch((error) => {
          logger.warn({ err: error, conversationId: conversation.conversationId }, "Failed to render improvement reporter conversation");
        });
      }
    } catch (error) {
      logger.warn({ err: error, durationMs: durationMs(startedAt) }, "Improvement reporter conversation poll failed");
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
    }
  };

  timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
  logger.info({ pollMs: input.pollMs ?? DEFAULT_POLL_MS }, "Started improvement reporter conversation renderer");
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Keeps triage and intermediate repair lifecycle changes silent. */
export function shouldDeliverImprovementReporterConversation(conversation: ImprovementReporterConversation) {
  if (!conversation.signalActive) return false;
  if (conversation.caseStatus === "resolved") return true;
  return conversation.caseStatus === "needs_evidence"
    && Boolean(conversation.clarificationQuestion)
    && conversation.clarificationAnswer == null;
}

export function renderImprovementReporterConversation(conversation: ImprovementReporterConversation) {
  let content: string;
  if (conversation.caseStatus === "resolved") {
    content = "The reported issue has been fixed and verified in production. Thanks for flagging it.";
  } else if (conversation.clarificationQuestion && !conversation.clarificationAnswer) {
    content = [
      "I need one detail to continue investigating this 🐛 report:",
      "",
      conversation.clarificationQuestion,
      "",
      "Reply here with the answer. I’ll resume automatically.",
    ].join("\n");
  } else {
    throw new Error("Improvement reporter conversation has no deliverable turn.");
  }
  return {
    content,
    signature: JSON.stringify({
      active: conversation.signalActive,
      status: conversation.caseStatus,
      resolution: conversation.caseResolution,
      questionTaskId: conversation.clarificationTaskId,
      question: conversation.clarificationQuestion,
      answered: conversation.clarificationAnswer != null,
    }),
  };
}

/** Consumes the mentioned reporter's explicit reply to a channel clarification. */
export async function handleImprovementClarificationReply(input: {
  repo: DiscordAiAgentRepository;
  jobs?: Pick<JobRuntime, "enqueueImprovementReconciliation">;
}, message: Message) {
  if (message.author.bot) return false;
  const answer = message.content?.trim();
  if (!answer) return false;
  if (!message.inGuild() || !message.reference?.messageId) return false;
  const result = await input.repo.answerImprovementReporterClarification({
    authorId: message.author.id,
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    referencedMessageId: message.reference?.messageId ?? null,
    answer,
  });
  if (!result) return false;
  await persistDiscordMessage(input.repo, message).catch((error) => {
    logger.warn({ err: error, messageId: message.id, caseId: result.caseId }, "Failed to archive an accepted improvement clarification");
  });
  await input.jobs?.enqueueImprovementReconciliation().catch((error) => {
    logger.warn({ err: error, caseId: result.caseId }, "Failed to wake improvement reconciliation after reporter clarification");
  });
  return true;
}

async function deliverReporterConversation(
  input: { client: Client; repo: DiscordAiAgentRepository; config: AppConfig },
  conversation: ImprovementReporterConversation,
) {
  const rendered = renderImprovementReporterConversation(conversation);
  if (conversation.lastRenderedSignature === rendered.signature
    && conversation.deliveryKind && conversation.deliveryChannelId && conversation.deliveryMessageId) {
    await input.repo.markImprovementReporterConversationRendered({
      conversationId: conversation.conversationId,
      deliveryKind: conversation.deliveryKind,
      deliveryChannelId: conversation.deliveryChannelId,
      deliveryMessageId: conversation.deliveryMessageId,
      signature: rendered.signature,
    });
    return;
  }
  try {
    const content = cleanResponse(rendered.content, input.config.maxReplyChars);
    const delivered = await replyToOriginalReport(input.client, conversation, content);
    await input.repo.markImprovementReporterConversationRendered({
      conversationId: conversation.conversationId,
      deliveryKind: delivered.kind,
      deliveryChannelId: delivered.message.channelId,
      deliveryMessageId: delivered.message.id,
      signature: rendered.signature,
    });
    logger.info({ conversationId: conversation.conversationId, caseId: conversation.caseId, deliveryKind: delivered.kind }, "Rendered improvement reporter conversation turn");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await input.repo.markImprovementReporterConversationDeliveryFailed({
      conversationId: conversation.conversationId,
      error: message,
      retryAt: reporterRetryAt(conversation.deliveryAttempts + 1),
    });
    if (failed.abandoned) {
      await input.repo.recordImprovementReconciliationDecision({
        caseId: conversation.caseId,
        eventName: "reconciliation.awaiting_operator",
        reason: "reporter_conversation_delivery_failed",
        metadata: { conversationId: conversation.conversationId, attempts: failed.attempts },
      });
    }
    throw error;
  }
}

export async function replyToOriginalReport(
  client: Client,
  conversation: ImprovementReporterConversation,
  content: string,
) {
  const channel = await client.channels.fetch(conversation.sourceChannelId);
  const messages = (channel as { messages?: { fetch?: (messageId: string) => Promise<Message> } } | null)?.messages;
  if (!messages?.fetch) throw new Error("The original report channel is unavailable.");
  const source = await messages.fetch(conversation.sourceMessageId);
  if (!source.inGuild() || source.guildId !== conversation.guildId) {
    throw new Error("The original report message is outside the expected server.");
  }
  const sent = await discordReply(source, {
    content: `<@${conversation.reporterId}> ${content}`,
    allowedMentions: { parse: [], users: [conversation.reporterId] },
  }, { logger, throwUnknown: false });
  if (!sent.ok) throw new Error(`Discord rejected the improvement report reply (${sent.reason}).`);
  return { kind: "channel" as const, message: sent.value };
}

function reporterRetryAt(attempt: number) {
  const delayMinutes = Math.min(30, 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delayMinutes * 60_000);
}
