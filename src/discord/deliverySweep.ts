import type { Client, Message } from "discord.js";
import type { Logger } from "pino";
import { agentRuntimeTurnInputText, type AgentRuntimeTurnEnvelope } from "../agent/runtimeEnvelope.js";
import { finishAgentRuntimePromptExecution } from "../agent/runtimeLedger.js";
import type { AgentRuntimeRepository, AgentRuntimeExecutionRecord } from "../db/agentRuntimeRepository.js";
import type { DeliveryObligationsRepository, DiscordDeliveryObligationRecord } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import {
  DISCORD_DELIVERY_INTENT_ARTIFACT_KIND,
  discordDeliveryIntentFiles,
  parseDiscordDeliveryIntent,
  type DiscordDeliveryIntent,
} from "./deliveryIntent.js";
import { discordEdit, discordReply } from "./api.js";
import { DiscordResponseSink } from "./responseSink.js";
import { deliverDiscordPresentation } from "./presentationDelivery.js";

const RESTART_NOTICE = "I was restarted before finishing this reply — please re-ask.";

type SweepExecutionSnapshot = {
  execution?: Pick<AgentRuntimeExecutionRecord, "status" | "error" | "metadata"> | null;
  finalText?: string | null;
  deliveryIntent?: DiscordDeliveryIntent | null;
};
export type DeliverySweepDecision =
  | { action: "deliver_intent"; intent: DiscordDeliveryIntent }
  | { action: "deliver"; content: string }
  | { action: "already_delivered"; replyMessageId: string }
  | { action: "abandon"; content: string; error: string }
  | { action: "wait" };

export function decideDiscordDeliverySweep(snapshot: SweepExecutionSnapshot): DeliverySweepDecision {
  if (!snapshot.execution) {
    return { action: "abandon", content: RESTART_NOTICE, error: "execution was missing during startup sweep" };
  }
  const replyMessageId = snapshot.execution.metadata?.replyMessageId;
  if (typeof replyMessageId === "string" && replyMessageId.trim()) {
    return { action: "already_delivered", replyMessageId };
  }
  // The intent is written only after the model has completed and before any Discord write.
  // It is therefore safe to recover even if the process died while the execution still said "running".
  if (snapshot.deliveryIntent) return { action: "deliver_intent", intent: snapshot.deliveryIntent };
  if (isTerminalStatus(snapshot.execution.status)) {
    const text = snapshot.finalText?.trim();
    if (text) return { action: "deliver", content: text };
    return { action: "abandon", content: RESTART_NOTICE, error: snapshot.execution.error ?? "terminal execution had no stored response text" };
  }
  return { action: "wait" };
}

export async function sweepDiscordDeliveryObligations(input: {
  client: Client;
  obligations: DeliveryObligationsRepository;
  agentRuntime?: AgentRuntimeRepository;
  repo: DiscordAiAgentRepository;
  logger: Logger;
  maxReplyChars: number;
  premiumSkuIds?: string[];
  olderThanMs?: number;
  limit?: number;
}) {
  if (!input.agentRuntime) return;
  const agentRuntime = input.agentRuntime;
  const pending = await input.obligations.listPendingOlderThan({ olderThanMs: input.olderThanMs ?? 30_000, limit: input.limit ?? 25 });
  for (const obligation of pending) {
    await sweepOne({ ...input, agentRuntime }, obligation).catch(async (error) => {
      input.logger.warn({ err: error, executionId: obligation.executionId }, "Discord delivery obligation sweep failed");
      await input.obligations.markAbandoned({ executionId: obligation.executionId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    });
  }
}

type SweepInput = {
  client: Client;
  obligations: DeliveryObligationsRepository;
  agentRuntime: AgentRuntimeRepository;
  repo: DiscordAiAgentRepository;
  logger: Logger;
  maxReplyChars: number;
  premiumSkuIds?: string[];
};

async function sweepOne(input: SweepInput, obligation: DiscordDeliveryObligationRecord) {
  const execution = await input.agentRuntime.getExecution({ executionId: obligation.executionId });
  const [finalText, intent, turnEnvelope] = await Promise.all([
    execution ? input.agentRuntime.getLatestResponseText({ executionId: obligation.executionId }) : null,
    loadDeliveryIntent(input.agentRuntime, obligation),
    loadTurnEnvelope(input.agentRuntime, obligation.executionId),
  ]);
  const decision = decideDiscordDeliverySweep({ execution, finalText, deliveryIntent: intent });
  if (decision.action === "wait") return;
  if (decision.action === "already_delivered") {
    input.logger.info({ executionId: obligation.executionId, replyMessageId: decision.replyMessageId }, "Discord delivery obligation already delivered; marking without re-sending");
    await input.obligations.markDelivered({ executionId: obligation.executionId, statusMessageId: decision.replyMessageId, metadata: { swept: true, reconciledWithoutResend: true } });
    return;
  }
  const source = await fetchMessage(input.client, obligation.channelId, obligation.sourceMessageId);
  const status = obligation.statusChannelId && obligation.statusMessageId
    ? await fetchMessage(input.client, obligation.statusChannelId, obligation.statusMessageId).catch(() => null)
    : null;
  if (decision.action === "deliver_intent") {
    if (!execution) throw new Error("Discord delivery intent cannot be recovered without its execution.");
    await deliverIntent(input, obligation, execution, source, status, decision.intent, turnEnvelope);
    return;
  }
  const content = cleanResponse(decision.content, input.maxReplyChars);
  let delivered: Message | null = null;
  if (status) {
    const edited = await discordEdit(status, { content }, { logger: input.logger });
    if (edited.ok) delivered = edited.value;
  }
  if (!delivered) {
    const replied = await discordReply(source, { content }, { logger: input.logger });
    if (!replied.ok) throw replied.error;
    delivered = replied.value;
  }
  if (decision.action === "deliver") {
    await input.obligations.markDelivered({ executionId: obligation.executionId, statusChannelId: delivered.channelId, statusMessageId: delivered.id, metadata: { swept: true, legacyTextRecovery: true } });
  } else {
    await input.obligations.markAbandoned({ executionId: obligation.executionId, error: decision.error, metadata: { swept: true, noticeMessageId: delivered.id } });
  }
}

async function deliverIntent(
  input: SweepInput,
  obligation: DiscordDeliveryObligationRecord,
  execution: AgentRuntimeExecutionRecord,
  source: Message,
  status: Message | null,
  intent: DiscordDeliveryIntent,
  envelope: AgentRuntimeTurnEnvelope | null,
) {
  const sink = new DiscordResponseSink({ client: input.client, sourceMessage: source, statusMessage: status, maxReplyChars: input.maxReplyChars, deliveryKey: intent.deliveryKey, logger: input.logger });
  const files = discordDeliveryIntentFiles(intent);
  const delivery = await deliverDiscordPresentation({
    responseSink: sink,
    repo: input.repo,
    logger: input.logger,
    executionId: execution.executionId,
    guildId: obligation.guildId,
    channelId: obligation.channelId,
    sourceMessageId: obligation.sourceMessageId,
    requesterUserId: intent.requesterUserId,
    content: intent.content,
    files,
    footer: intent.footer,
    presentation: intent.presentation,
    premiumSkuIds: input.premiumSkuIds,
  });
  const { reply, richPresentationDelivered, actionGenerationId } = delivery;
  const reaction = intent.sourceMessageReaction ? await sink.addSourceMessageReactions([intent.sourceMessageReaction]) : null;
  await input.obligations.markDelivered({
    executionId: execution.executionId,
    statusChannelId: reply.channelId,
    statusMessageId: reply.id,
    metadata: { swept: true, recoveredFromIntent: true, richPresentationDelivered, actionGenerationId },
  });
  const session = await input.agentRuntime.getSession({ sessionId: execution.sessionId });
  await finishAgentRuntimePromptExecution({
    agentRuntime: input.agentRuntime,
    session,
    executionId: execution.executionId,
    traceId: execution.traceId,
    status: "succeeded",
    replyMessageId: reply.id,
    replyUrl: reply.url,
    responseContent: intent.storedContent,
    durationMs: Math.max(0, Date.now() - execution.createdAt.getTime()),
    executorName: execution.harness,
  }).catch((error) => input.logger.warn({ err: error, executionId: execution.executionId, replyMessageId: reply.id }, "Failed to reconcile recovered agent execution"));
  if (envelope) {
    await input.repo.appendConversationTurn({
      threadKey: envelope.threadKey,
      turnId: envelope.requestId,
      user: {
        discordMessageId: envelope.requestId,
        authorId: envelope.userId,
        authorDisplayName: envelope.userDisplayName,
        content: agentRuntimeTurnInputText(envelope),
        createdAt: new Date(envelope.messageCreatedAt),
        metadata: { discordUrl: envelope.discordUrl, requestKind: envelope.requestKind ?? "message", sourceMessageId: obligation.sourceMessageId, recovered: true },
      },
      assistant: {
        discordMessageId: reply.id,
        authorId: input.client.user?.id ?? null,
        authorDisplayName: input.client.user?.username ?? null,
        content: intent.storedContent,
        metadata: {
          discordUrl: reply.url,
          responseRedacted: intent.responseRedacted,
          recovered: true,
          sourceMessageReaction: reaction?.added[0] ?? null,
          files: files.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })),
        },
      },
    }).catch((error) => input.logger.warn({ err: error, executionId: execution.executionId, replyMessageId: reply.id }, "Failed to reconcile recovered conversation memory"));
  }
  input.logger.info({ executionId: execution.executionId, replyMessageId: reply.id, richPresentationDelivered }, "Recovered durable Discord delivery intent");
}

async function loadDeliveryIntent(agentRuntime: AgentRuntimeRepository, obligation: DiscordDeliveryObligationRecord): Promise<DiscordDeliveryIntent | null> {
  const artifactId = typeof obligation.metadata.deliveryIntentArtifactId === "string" ? obligation.metadata.deliveryIntentArtifactId : null;
  const artifact = artifactId
    ? await agentRuntime.getArtifact({ artifactId })
    : await agentRuntime.getLatestArtifactContentForExecution({ executionId: obligation.executionId, kind: DISCORD_DELIVERY_INTENT_ARTIFACT_KIND });
  if (!artifact?.content) return null;
  try {
    return parseDiscordDeliveryIntent(artifact.content);
  } catch {
    return null;
  }
}

async function loadTurnEnvelope(agentRuntime: AgentRuntimeRepository, executionId: string): Promise<AgentRuntimeTurnEnvelope | null> {
  const artifact = await agentRuntime.getLatestArtifactContentForExecution({ executionId, kind: "turn_envelope" });
  if (!artifact?.content) return null;
  try {
    const parsed = JSON.parse(artifact.content) as AgentRuntimeTurnEnvelope;
    return (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) && parsed.source === "discord" ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchMessage(client: Client, channelId: string, messageId: string): Promise<Message> {
  const channel = await client.channels.fetch(channelId);
  const messages = (channel as any)?.messages;
  if (!messages?.fetch) throw new Error(`Discord channel ${channelId} cannot fetch messages.`);
  return (await messages.fetch(messageId)) as Message;
}

function isTerminalStatus(status: string | undefined) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}
