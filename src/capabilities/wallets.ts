import type { AppConfig } from "../config/env.js";

export function walletsAvailable(config: AppConfig) {
  return config.payments.walletEnabled;
}

export function userWalletsAvailable(config: AppConfig) {
  return config.payments.walletEnabled && config.payments.userWalletsEnabled;
}
