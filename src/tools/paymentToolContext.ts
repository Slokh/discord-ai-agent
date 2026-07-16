import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import type { PaymentEventRecorder } from "../payments/types.js";
import type { ToolContext } from "./types.js";

const TEMPO_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

export function paymentRecorder(ctx: ToolContext): PaymentEventRecorder {
  return async (event) => {
    appendTempoTransactionFooter(ctx, event.metadata?.transactionHash);
    await recordAgentEvent(ctx, {
      ...event,
      traceId: ctx.requestId,
      requestId: ctx.requestId,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      messageId: ctx.requestMessageId
    });
  };
}

export function appendTempoTransactionFooter(ctx: ToolContext, transactionHash: unknown): void {
  if (typeof transactionHash !== "string" || !TEMPO_TRANSACTION_HASH.test(transactionHash)) return;
  const explorer = ctx.config.payments.tempoNetwork === "moderato"
    ? "https://explore.testnet.tempo.xyz"
    : "https://explore.tempo.xyz";
  const url = `${explorer}/tx/${transactionHash}`;
  const line = `💸 transaction ${shortHash(transactionHash)} <${url}>`;
  const footerLines = (ctx.footerLines = ctx.footerLines ?? []);
  if (!footerLines.includes(line)) footerLines.push(line);
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
