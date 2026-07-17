import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { explicitWalletTransferForPrompt, walletActionToolForPrompt } from "../../src/agent/walletActionGuard.js";

describe("wallet action guard", () => {
  const config = loadConfig();
  config.payments.walletEnabled = true;
  config.payments.userWalletsEnabled = true;

  it.each([
    ["give luke back $1 so he can use it", "transferWalletFunds"],
    ["send $.50 to @friend", "transferWalletFunds"],
    ["send Luke .3", "transferWalletFunds"],
    ["send 0.3 to Luke", "transferWalletFunds"],
    ["🙂 send it to the bot please 🙂", "transferWalletFunds"],
    ["I'm at $0, can I get $1 to play again?", "requestStarterFunds"]
  ] as const)("routes %s", (prompt, expected) => {
    expect(walletActionToolForPrompt(config, prompt)).toBe(expected);
  });

  it.each([
    "again",
    "bet .05 blackjack",
    "put $0.50 on heads",
    "give me advice about saving $1",
    "don't transfer $1 to Luke",
    "send Luke $1 in play money",
    "send it to Luke"
  ])("does not capture non-transfer prompt: %s", (prompt) => {
    expect(walletActionToolForPrompt(config, prompt)).toBeNull();
  });

  it.each([
    ["send luke 1.00", { amountUsd: 1, destination: { kind: "user", reference: "luke" } }],
    ["give Luke back $1 so he can use it", { amountUsd: 1, destination: { kind: "user", reference: "Luke" } }],
    ["send $.50 to the bot wallet", { amountUsd: 0.5, destination: { kind: "bot" } }],
    ["transfer two dollars back to treasury", { amountUsd: 2, destination: { kind: "bot" } }],
    ["🙂 send it to the bot please 🙂", { amountUsd: "balance", destination: { kind: "bot" } }],
    ["send my whole balance to Luke", { amountUsd: "balance", destination: { kind: "user", reference: "Luke" } }],
  ] as const)("grounds the transfer in the requester prompt: %s", (prompt, expected) => {
    expect(explicitWalletTransferForPrompt(prompt)).toEqual(expected);
  });
});
