import type { Client, Message } from "discord.js";
import type { Logger } from "pino";
import type { AgentRuntimeRepository, AgentRuntimeExecutionRecord } from "../db/agentRuntimeRepository.js";
import type { DeliveryObligationsRepository, DiscordDeliveryObligationRecord } from "../db/deliveryObligationsRepository.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import { discordEdit, discordReply } from "./api.js";

const RESTART_NOTICE = "I was restarted before finishing this reply — please re-ask.";

type SweepExecutionSnapshot = { execution?: Pick<AgentRuntimeExecutionRecord, "status" | "error" | "metadata"> | null; finalText?: string | null };
export type DeliverySweepDecision =
  | { action: "deliver"; content: string }
  | { action: "already_delivered"; replyMessageId: string }
  | { action: "abandon"; content: string; error: string }
  | { action: "wait" };

export function decideDiscordDeliverySweep(snapshot: SweepExecutionSnapshot): DeliverySweepDecision {
  const status = snapshot.execution?.status;
  if (isTerminalStatus(status)) {
    const replyMessageId = snapshot.execution?.metadata?.replyMessageId;
    if (typeof replyMessageId === "string" && replyMessageId.trim()) {
      return { action: "already_delivered", replyMessageId };
    }
    const text = snapshot.finalText?.trim();
    if (text) return { action: "deliver", content: text };
    return { action: "abandon", content: RESTART_NOTICE, error: snapshot.execution?.error ?? "terminal execution had no stored response text" };
  }
  return { action: "abandon", content: RESTART_NOTICE, error: "execution was not terminal during startup sweep" };
}

export async function sweepDiscordDeliveryObligations(input: {
  client: Client;
  obligations: DeliveryObligationsRepository;
  agentRuntime?: AgentRuntimeRepository;
  logger: Logger;
  maxReplyChars: number;
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

async function sweepOne(input: { client: Client; obligations: DeliveryObligationsRepository; agentRuntime: AgentRuntimeRepository; logger: Logger; maxReplyChars: number }, obligation: DiscordDeliveryObligationRecord) {
  const execution = await input.agentRuntime.getExecution?.({ executionId: obligation.executionId });
  const finalText = execution ? await input.agentRuntime.getLatestResponseText?.({ executionId: obligation.executionId }) : null;
  const decision = decideDiscordDeliverySweep({ execution, finalText });
  if (decision.action === "wait") return;
  if (decision.action === "already_delivered") {
    input.logger.info({ executionId: obligation.executionId, replyMessageId: decision.replyMessageId }, "Discord delivery obligation already delivered; marking without re-sending");
    await input.obligations.markDelivered({ executionId: obligation.executionId, statusMessageId: decision.replyMessageId, metadata: { swept: true, reconciledWithoutResend: true } });
    return;
  }
  const source = await fetchMessage(input.client, obligation.channelId, obligation.sourceMessageId);
  const status = obligation.statusChannelId && obligation.statusMessageId ? await fetchMessage(input.client, obligation.statusChannelId, obligation.statusMessageId).catch(() => null) : null;
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
    await input.obligations.markDelivered({ executionId: obligation.executionId, statusChannelId: delivered.channelId, statusMessageId: delivered.id, metadata: { swept: true } });
  } else {
    await input.obligations.markAbandoned({ executionId: obligation.executionId, error: decision.error, metadata: { swept: true, noticeMessageId: delivered.id } });
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
