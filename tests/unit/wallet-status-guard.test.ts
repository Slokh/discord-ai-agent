import { describe, expect, it } from "vitest";
import { shouldForceSharedWalletStatus } from "../../src/agent/walletStatusGuard.js";
import { loadConfig } from "../../src/config/env.js";

function configuredMpp() {
  const config = loadConfig();
  config.payments.walletEnabled = true;
  config.payments.userWalletsEnabled = false;
  config.payments.mppEnabled = true;
  config.payments.privyAppId = "app";
  config.payments.privyAppSecret = "secret";
  return config;
}

describe("shared wallet status guard", () => {
  it.each([
    "balance",
    "your balance",
    "what's your wallet balance?",
    "show the bot's balance",
    "check MPP wallet balance now"
  ])("forces the shared wallet tool for an unqualified MPP balance request: %s", (text) => {
    expect(shouldForceSharedWalletStatus(configuredMpp(), text)).toBe(true);
  });

  it.each([
    "my bank balance",
    "my game balance",
    "balance these equations",
    "what is the server balance of power?"
  ])("does not capture qualified or unrelated balance requests: %s", (text) => {
    expect(shouldForceSharedWalletStatus(configuredMpp(), text)).toBe(false);
  });

  it("does not force the shared wallet when user wallets are enabled", () => {
    const config = configuredMpp();
    config.payments.userWalletsEnabled = true;

    expect(shouldForceSharedWalletStatus(config, "balance")).toBe(false);
  });
});
