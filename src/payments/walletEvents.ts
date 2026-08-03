import type { PaymentEventRecorder } from "./types.js";

export const SHARED_BOT_GUILD_ID = "__shared_bot__";

export async function emitPaymentEvent(
  record: PaymentEventRecorder | undefined,
  event: Parameters<PaymentEventRecorder>[0],
): Promise<void> {
  if (!record) return;
  await record(event).catch(() => undefined);
}
