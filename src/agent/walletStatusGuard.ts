import type { AppConfig } from "../config/env.js";

const UNQUALIFIED_SHARED_BALANCE =
  /^(?:(?:what(?:'s| is)|show|check|give me|tell me)\s+)?(?:(?:your|the bot(?:'s)?|bot(?:'s)?|shared(?: bot)?|mpp)\s+)?(?:wallet\s+)?balance(?:\s+(?:please|now))?[?.!]*$/i;

export function shouldForceSharedWalletStatus(config: AppConfig, text: string): boolean {
  const payments = config.payments;
  if (!payments) return false;
  return Boolean(
    payments.walletEnabled &&
      payments.mppEnabled &&
      payments.privyAppId &&
      payments.privyAppSecret &&
      !payments.userWalletsEnabled &&
      UNQUALIFIED_SHARED_BALANCE.test(text.trim())
  );
}
