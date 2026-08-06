import type { Client, Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, ImprovementBotUpdate } from "../db/repositories.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import { durationMs, logger } from "../util/logger.js";
import { discordEdit, discordSend } from "./api.js";

const DEFAULT_POLL_MS = 2_000;
const RENDER_LIMIT = 50;

export type ImprovementBotUpdateNotifierRuntime = { stop: () => void };

/** Renders content-free automation incidents as standalone messages in the one bot channel. */
export function startImprovementBotUpdateNotifier(input: {
  client: Client;
  repo: DiscordAiAgentRepository;
  config: AppConfig;
  pollMs?: number;
}): ImprovementBotUpdateNotifierRuntime {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = Date.now();
    try {
      if (!input.client.isReady()) return;
      const updates = await input.repo.listRenderableImprovementBotUpdates(RENDER_LIMIT);
      for (const update of updates) {
        await deliverImprovementBotUpdate(input, update).catch((error) => {
          logger.warn({ err: error, updateId: update.updateId, caseId: update.caseId }, "Failed to render improvement bot update");
        });
      }
    } catch (error) {
      logger.warn({ err: error, durationMs: durationMs(startedAt) }, "Improvement bot update poll failed");
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
    }
  };
  timer = setTimeout(tick, input.pollMs ?? DEFAULT_POLL_MS);
  logger.info({ pollMs: input.pollMs ?? DEFAULT_POLL_MS }, "Started improvement bot update renderer");
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function renderImprovementBotUpdate(update: ImprovementBotUpdate) {
  const producer = producerLabel(update.producerTrigger);
  let content: string;
  if (update.caseStatus === "resolved") {
    content = `${producer} recovered, and the recovery has been verified in production.`;
  } else if (update.caseStatus === "dismissed") {
    content = `${producer} health incident was assessed and closed without a code change.`;
  } else if (update.caseStatus === "verifying") {
    content = `A repair for ${producer.toLowerCase()} has shipped. Recovery is being verified in production.`;
  } else if (update.caseStatus === "in_progress" || update.caseStatus === "actionable") {
    content = `${producer} is unhealthy. An automated repair is queued or in progress; I’ll update this message when recovery is verified.`;
  } else {
    content = `${producer} is unhealthy (${reasonLabel(update.livenessReason)}). The incident is in the improvement stream and is awaiting automatic assessment.`;
  }
  return {
    content,
    signature: JSON.stringify({
      status: update.caseStatus,
      resolution: update.caseResolution,
      trigger: update.producerTrigger,
      reason: update.livenessReason,
    }),
  };
}

async function deliverImprovementBotUpdate(
  input: { client: Client; repo: DiscordAiAgentRepository; config: AppConfig },
  update: ImprovementBotUpdate,
) {
  const channelId = input.config.discord.botChannelId;
  const rendered = renderImprovementBotUpdate(update);
  if (update.lastRenderedSignature === rendered.signature && update.deliveryChannelId && update.deliveryMessageId) return;
  try {
    if (!channelId) throw new Error("The configured Discord bot channel is unavailable.");
    const channel = await input.client.channels.fetch(channelId);
    if (!channel || typeof (channel as any).send !== "function") throw new Error("The configured Discord bot channel is not message-capable.");
    const content = cleanResponse(rendered.content, input.config.maxReplyChars);
    let message: Message;
    if (update.deliveryChannelId === channelId && update.deliveryMessageId && "messages" in channel) {
      message = await (channel as any).messages.fetch(update.deliveryMessageId);
      const edited = await discordEdit(message, content, { logger });
      if (!edited.ok) throw edited.error;
      message = edited.value;
    } else {
      const sent = await discordSend(channel as any, { content, allowedMentions: { parse: [] } }, { logger });
      if (!sent.ok) throw sent.error;
      message = sent.value;
    }
    await input.repo.markImprovementBotUpdateRendered({
      updateId: update.updateId,
      deliveryChannelId: channelId,
      deliveryMessageId: message.id,
      signature: rendered.signature,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.repo.markImprovementBotUpdateDeliveryFailed({
      updateId: update.updateId,
      error: message,
      retryAt: new Date(Date.now() + 30_000),
    });
    throw error;
  }
}

function producerLabel(trigger: ImprovementBotUpdate["producerTrigger"]) {
  if (trigger === "improvement_reconciliation") return "The improvement reconciler";
  if (trigger === "improvement_watchdog") return "The external improvement watchdog";
  return `The ${trigger.replaceAll("_", " ")} proof producer`;
}

function reasonLabel(reason: ImprovementBotUpdate["livenessReason"]) {
  if (reason === "missed_sla") return "its expected heartbeat is missing";
  if (reason === "run_in_progress_too_long") return "a run is stuck";
  if (reason === "repeated_failures") return "several runs failed";
  if (reason === "latest_run_failed") return "its latest run failed";
  return "health could not be confirmed";
}
