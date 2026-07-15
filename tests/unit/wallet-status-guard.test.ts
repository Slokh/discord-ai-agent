import { describe, expect, it } from "vitest";
import { shouldForceWalletBalance, walletBalanceOwnerForPrompt } from "../../src/agent/walletStatusGuard.js";
import { loadConfig } from "../../src/config/env.js";

function configuredWallets() {
  const config = loadConfig();
  config.payments.walletEnabled = true;
  config.payments.userWalletsEnabled = true;
  config.payments.privyAppId = "app";
  config.payments.privyAppSecret = "secret";
  return config;
}

describe("wallet balance guard", () => {
  it.each([
    "balance",
    "your balance",
    "what's your wallet balance?",
    "show the bot's balance",
    "check my casino funds now",
    "what's my bankroll?"
  ])("forces a verified wallet lookup for a balance request: %s", (text) => {
    expect(shouldForceWalletBalance(configuredWallets(), text)).toBe(true);
  });

  it.each([
    "my bank balance",
    "transfer $2 from my balance to the bot",
    "balance these equations",
    "what is the server balance of power?"
  ])("does not capture qualified or unrelated balance requests: %s", (text) => {
    expect(shouldForceWalletBalance(configuredWallets(), text)).toBe(false);
  });

  it("does not force a wallet lookup when the wallet runtime is disabled", () => {
    const config = configuredWallets();
    config.payments.walletEnabled = false;

    expect(shouldForceWalletBalance(config, "balance")).toBe(false);
  });

  it.each([
    ["balance", "requester"],
    ["what's my bankroll?", "requester"],
    ["can you check my wallet balance?", "requester"],
    ["your balance", "bot"],
    ["what's your wallet balance?", "bot"],
    ["show the bot's balance", "bot"],
    ["how much balance do you have?", "bot"],
  ] as const)("binds wallet ownership for %s", (text, owner) => {
    expect(walletBalanceOwnerForPrompt(configuredWallets(), text)).toBe(owner);
  });
});
