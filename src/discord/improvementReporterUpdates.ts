import type { Client, Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, ImprovementReporterUpdate } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import { durationMs, logger } from "../util/logger.js";
import { discordEdit, discordSend } from "./api.js";

const DEFAULT_POLL_MS = 2_000;
const RENDER_LIMIT = 50;

export type ImprovementReporterNotifierRuntime = { stop: () => void };

/** Delivers every case transition into the private Discord message created for its reporter. */
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
      const updates = await input.repo.listRenderableImprovementReporterUpdates(RENDER_LIMIT);
      for (const update of updates) {
        await deliverReporterUpdate(input, update).catch((error) => {
          logger.warn({ err: error, updateId: update.updateId }, "Failed to render private improvement reporter update");
        });
      }
    } catch (error) {
      logger.warn({ err: error, durationMs: durationMs(startedAt) }, "Improvement reporter notifier poll failed");
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
    }
  };

  timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
  logger.info({ pollMs: input.pollMs ?? DEFAULT_POLL_MS }, "Started private improvement reporter renderer");
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function renderImprovementReporterUpdate(update: ImprovementReporterUpdate) {
  let content: string;
  if (!update.signalActive) {
    content = "You removed the 🐛 report, so I stopped tracking it. Add the reaction again if you want me to reopen it.";
  } else if (update.caseStatus === "resolved") {
    content = "The issue you reported has been fixed and verified in production. Thanks for flagging it.";
  } else if (update.caseStatus === "dismissed") {
    content = update.caseResolution && update.caseResolution !== "All source signals were withdrawn."
      ? `I finished reviewing the message you reported and closed it: ${update.caseResolution}`
      : "I finished reviewing the message you reported and couldn’t confirm an issue that needs a change.";
  } else if (update.caseStatus === "actionable") {
    content = "I confirmed the issue you reported and prepared an executable fix contract. Work is ready to start.";
  } else if (update.caseStatus === "in_progress") {
    content = "I confirmed the issue you reported and a fix is in progress. I’ll update this message when it ships.";
  } else if (update.caseStatus === "verifying") {
    content = "A fix for the issue you reported has shipped and is being verified in production.";
  } else if (update.clarificationQuestion && !update.clarificationAnswer) {
    content = [
      "I need one detail to continue investigating the message you marked with 🐛:",
      "",
      update.clarificationQuestion,
      "",
      "Reply directly to this message with the answer. I’ll resume automatically.",
    ].join("\n");
  } else if (update.clarificationAnswer) {
    content = "Thanks — I added your clarification and resumed the investigation. I’ll update this message when there’s an outcome.";
  } else if (update.caseStatus === "needs_evidence") {
    content = "I’m still investigating the message you marked with 🐛 and gathering the evidence needed to decide what to change.";
  } else {
    content = "I’m looking into the message you marked with 🐛. I’ll keep this private message updated as I investigate it.";
  }
  return {
    content,
    signature: JSON.stringify({
      active: update.signalActive,
      status: update.caseStatus,
      resolution: update.caseResolution,
      questionTaskId: update.clarificationTaskId,
      question: update.clarificationQuestion,
      answered: update.clarificationAnswer != null,
    }),
  };
}

/** Consumes only an explicit reply to the bot's current clarification DM. */
export async function handleImprovementClarificationReply(input: {
  repo: DiscordAiAgentRepository;
  jobs?: Pick<JobRuntime, "enqueueImprovementReconciliation">;
}, message: Message) {
  if (message.inGuild() || message.author.bot) return false;
  const referencedMessageId = message.reference?.messageId;
  const answer = message.content?.trim();
  if (!referencedMessageId || !answer) return false;
  const result = await input.repo.answerImprovementReporterClarification({
    reporterId: message.author.id,
    dmChannelId: message.channelId,
    dmMessageId: referencedMessageId,
    answer,
  });
  if (!result) return false;
  await input.jobs?.enqueueImprovementReconciliation().catch((error) => {
    logger.warn({ err: error, caseId: result.caseId }, "Failed to wake improvement reconciliation after reporter clarification");
  });
  return true;
}

async function deliverReporterUpdate(
  input: { client: Client; repo: DiscordAiAgentRepository; config: AppConfig },
  update: ImprovementReporterUpdate,
) {
  const rendered = renderImprovementReporterUpdate(update);
  if (update.lastRenderedSignature === rendered.signature && update.dmChannelId && update.dmMessageId) {
    await input.repo.markImprovementReporterUpdateRendered({
      updateId: update.updateId,
      dmChannelId: update.dmChannelId,
      dmMessageId: update.dmMessageId,
      signature: rendered.signature,
    });
    return;
  }
  try {
    const content = cleanResponse(rendered.content, input.config.maxReplyChars);
    const delivered = await editOrSendPrivateUpdate(input.client, update, content);
    await input.repo.markImprovementReporterUpdateRendered({
      updateId: update.updateId,
      dmChannelId: delivered.channelId,
      dmMessageId: delivered.id,
      signature: rendered.signature,
    });
    logger.info({ updateId: update.updateId, caseId: update.caseId }, "Rendered private improvement reporter update");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await input.repo.markImprovementReporterUpdateDeliveryFailed({
      updateId: update.updateId,
      error: message,
      retryAt: reporterRetryAt(update.deliveryAttempts + 1),
    });
    if (failed.abandoned) {
      await input.repo.recordImprovementReconciliationDecision({
        caseId: update.caseId,
        eventName: "reconciliation.awaiting_operator",
        reason: "reporter_private_delivery_failed",
        metadata: { updateId: update.updateId, attempts: failed.attempts },
      });
    }
    throw error;
  }
}

async function editOrSendPrivateUpdate(client: Client, update: ImprovementReporterUpdate, content: string) {
  if (update.dmChannelId && update.dmMessageId) {
    const channel = await client.channels.fetch(update.dmChannelId);
    const messages = (channel as { messages?: { fetch?: (messageId: string) => Promise<Message> } } | null)?.messages;
    if (messages?.fetch) {
      const existing = await messages.fetch(update.dmMessageId).catch(() => null);
      if (existing) {
        const edited = await discordEdit(existing, content, { logger, throwUnknown: false });
        if (edited.ok) return edited.value;
        if (edited.reason !== "unknown_message") throw new Error(`Discord rejected the private update (${edited.reason}).`);
      }
    }
  }
  const user = await client.users.fetch(update.reporterId);
  const channel = await user.createDM();
  const sent = await discordSend(channel, { content }, { logger, throwUnknown: false });
  if (!sent.ok) throw new Error(`Discord rejected the private update (${sent.reason}).`);
  return sent.value;
}

function reporterRetryAt(attempt: number) {
  const delayMinutes = Math.min(30, 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delayMinutes * 60_000);
}
