import { logger } from "../util/logger.js";
import type { WalletService } from "./walletService.js";

export function startPaymentReconciler(input: { walletService: WalletService; intervalMs?: number }) {
  let running = false;
  let runs = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await input.walletService.reconcile();
      if (result.checked > 0) logger.info(result, "Payment reconciliation completed");
      runs += 1;
      if (runs === 1 || runs % 5 === 0) {
        const health = await input.walletService.recordBotWalletHealth();
        if (health.status !== "ok") logger.warn(health, "Shared bot wallet balance is low");
      }
    } catch (error) {
      logger.warn({ err: error }, "Payment reconciliation failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), input.intervalMs ?? 60_000);
  timer.unref?.();
  void run();
  return { stop: () => clearInterval(timer) };
}
