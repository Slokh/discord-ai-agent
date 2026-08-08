import {
  ChannelType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type Client,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, ImprovementReporterConversation } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import { durationMs, logger } from "../util/logger.js";
import { discordSend } from "./api.js";
import { persistDiscordMessage } from "./messagePersistence.js";

const DEFAULT_POLL_MS = 2_000;
const RENDER_LIMIT = 50;
const THREAD_NAME = "🐛 report follow-up";

export type ImprovementReporterNotifierRuntime = { stop: () => void };

/** Posts case transitions as turns in the configured bot channel, with DM as a bounded fallback. */
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

/** Keeps autonomous triage silent until a reporter answer or repair lifecycle needs a durable conversation. */
export function shouldDeliverImprovementReporterConversation(conversation: ImprovementReporterConversation) {
  if (conversation.deliveryKind) return true;
  if (!conversation.signalActive) return false;
  if (["in_progress", "verifying", "resolved"].includes(conversation.caseStatus)) return true;
  return conversation.caseStatus === "needs_evidence"
    && Boolean(conversation.clarificationQuestion)
    && conversation.clarificationAnswer == null;
}

export function renderImprovementReporterConversation(conversation: ImprovementReporterConversation) {
  let content: string;
  if (!conversation.signalActive) {
    content = "The 🐛 report was removed, so I stopped tracking it. Add the reaction again to reopen it.";
  } else if (conversation.caseStatus === "resolved") {
    content = "The reported issue has been fixed and verified in production. Thanks for flagging it.";
  } else if (conversation.caseStatus === "dismissed") {
    content = conversation.caseResolution && conversation.caseResolution !== "All source signals were withdrawn."
      ? `I finished reviewing this report and closed it: ${conversation.caseResolution}`
      : "I finished reviewing this report and couldn’t confirm an issue that needs a change.";
  } else if (conversation.caseStatus === "actionable") {
    content = "I confirmed the reported issue and prepared an executable fix contract. Work is ready to start.";
  } else if (conversation.caseStatus === "in_progress") {
    content = "I confirmed the reported issue and a fix is in progress. I’ll post here when it ships.";
  } else if (conversation.caseStatus === "verifying") {
    content = "A fix for the reported issue has shipped and is being verified in production.";
  } else if (conversation.clarificationQuestion && !conversation.clarificationAnswer) {
    content = [
      "I need one detail to continue investigating this 🐛 report:",
      "",
      conversation.clarificationQuestion,
      "",
      "Reply here with the answer. I’ll resume automatically.",
    ].join("\n");
  } else if (conversation.clarificationAnswer) {
    content = "Thanks — I added that clarification and resumed the investigation. I’ll post here when there’s an outcome.";
  } else if (conversation.caseStatus === "needs_evidence") {
    content = "I’m still investigating this 🐛 report and gathering the evidence needed to decide what to change.";
  } else {
    content = "I’m looking into this 🐛 report. I’ll post follow-up questions and outcomes here.";
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

/** Consumes a natural thread follow-up, or an explicit reply in the fallback DM. */
export async function handleImprovementClarificationReply(input: {
  repo: DiscordAiAgentRepository;
  jobs?: Pick<JobRuntime, "enqueueImprovementReconciliation">;
}, message: Message) {
  if (message.author.bot) return false;
  const answer = message.content?.trim();
  if (!answer) return false;
  if (message.inGuild() && !message.channel.isThread()) return false;
  if (!message.inGuild() && !message.reference?.messageId) return false;
  const result = await input.repo.answerImprovementReporterClarification({
    authorId: message.author.id,
    guildId: message.inGuild() ? message.guildId : null,
    channelId: message.channelId,
    messageId: message.id,
    referencedMessageId: message.reference?.messageId ?? null,
    answer,
  });
  if (!result) return false;
  if (message.inGuild()) {
    await persistDiscordMessage(input.repo, message).catch((error) => {
      logger.warn({ err: error, messageId: message.id, caseId: result.caseId }, "Failed to archive an accepted improvement clarification");
    });
  }
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
    const delivered = await sendConversationTurn(
      input.client,
      conversation,
      content,
      input.config.discord.botChannelId,
    );
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

async function sendConversationTurn(
  client: Client,
  conversation: ImprovementReporterConversation,
  content: string,
  reportChannelId: string | null,
) {
  if (conversation.deliveryKind === "thread" && conversation.deliveryChannelId) {
    try {
      const channel = await client.channels.fetch(conversation.deliveryChannelId);
      if (channel?.isThread()) {
        await reopenThread(channel);
        return { kind: "thread" as const, message: await sendMessage(channel, content) };
      }
    } catch (error) {
      logger.warn({ err: error, conversationId: conversation.conversationId }, "Reporter thread became unavailable; falling back to DM");
    }
    return sendFallbackDm(client, conversation, content);
  }
  if (conversation.deliveryKind === "dm") return sendFallbackDm(client, conversation, content);

  try {
    const thread = await resolveImprovementReporterThread(client, conversation, reportChannelId);
    if (thread) {
      await reopenThread(thread);
      return {
        kind: "thread" as const,
        message: await sendMessage(thread, `<@${conversation.reporterId}> ${content}`, conversation.reporterId),
      };
    }
  } catch (error) {
    logger.warn({ err: error, conversationId: conversation.conversationId }, "Could not create reporter thread; falling back to DM");
  }
  return sendFallbackDm(client, conversation, content);
}

export async function resolveImprovementReporterThread(
  client: Client,
  conversation: ImprovementReporterConversation,
  reportChannelId: string | null,
) {
  if (!reportChannelId) return null;
  const reportChannel = await client.channels.fetch(reportChannelId);
  if (!reportChannel || reportChannel.type !== ChannelType.GuildText || reportChannel.guildId !== conversation.guildId) return null;
  const reporter = await reportChannel.guild.members.fetch(conversation.reporterId);
  const permissions = reportChannel.permissionsFor(reporter);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads])) return null;
  return reportChannel.threads.create({
    name: THREAD_NAME,
    type: ChannelType.PublicThread,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    reason: "Follow-up conversation for a member improvement report",
  });
}

async function reopenThread(thread: { archived?: boolean | null; setArchived: (archived: boolean, reason?: string) => Promise<unknown> }) {
  if (thread.archived) await thread.setArchived(false, "Continuing an improvement report follow-up");
}

async function sendFallbackDm(client: Client, conversation: ImprovementReporterConversation, content: string) {
  const user = await client.users.fetch(conversation.reporterId);
  const channel = await user.createDM();
  return { kind: "dm" as const, message: await sendMessage(channel, content) };
}

async function sendMessage(
  channel: { send: (payload: MessageCreateOptions) => Promise<Message> },
  content: string,
  mentionUserId?: string,
) {
  const sent = await discordSend(channel, {
    content,
    allowedMentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] },
  }, { logger, throwUnknown: false });
  if (!sent.ok) throw new Error(`Discord rejected the reporter conversation turn (${sent.reason}).`);
  return sent.value;
}

function reporterRetryAt(attempt: number) {
  const delayMinutes = Math.min(30, 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delayMinutes * 60_000);
}
