import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { walletActionToolForPrompt } from "../../src/agent/walletActionGuard.js";

describe("wallet action guard", () => {
  const config = loadConfig();
  config.payments.walletEnabled = true;
  config.payments.userWalletsEnabled = true;

  it.each([
    ["give luke back $1 so he can use it", "transferWalletFunds"],
    ["send $.50 to @friend", "transferWalletFunds"],
    ["send Luke .3", "transferWalletFunds"],
    ["send 0.3 to Luke", "transferWalletFunds"],
    ["I'm at $0, can I get $1 to play again?", "requestStarterFunds"]
  ] as const)("routes %s", (prompt, expected) => {
    expect(walletActionToolForPrompt(config, prompt)).toBe(expected);
  });

  it.each([
    "again",
    "bet .05 blackjack",
    "put $0.50 on heads",
    "give me advice about saving $1"
  ])("does not capture non-transfer prompt: %s", (prompt) => {
    expect(walletActionToolForPrompt(config, prompt)).toBeNull();
  });
});
