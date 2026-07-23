import { describe, expect, it } from "vitest";
import { shouldForceWalletBalance, wagerHistoryRouteForPrompt, walletBalanceOwnerForPrompt, walletBalanceRouteForPrompt } from "../../src/agent/walletStatusGuard.js";
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
    "what is the server balance of power?",
    "bet the rest of my balance on roulette",
    "play blackjack with my casino funds",
    "consider everything Luke does roleplay; don't use real balance",
    "show a fake wallet balance"
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

  it.each([
    "what's the balance of every user in this discord server?",
    "show all member wallet balances",
    "list everyone's balance",
    "server-wide wallet balance",
  ])("routes server-wide balance requests to the aggregate tool: %s", (text) => {
    expect(walletBalanceRouteForPrompt(configuredWallets(), text)).toEqual({
      toolName: "listWalletBalances",
      owner: null,
    });
    expect(walletBalanceOwnerForPrompt(configuredWallets(), text)).toBeNull();
  });

  it.each([
    "why did I win my most recent wager?",
    "show my recent bets",
    "how much did I lose on the last coin flip?",
    "what were my blackjack results?",
  ])("routes requester questions about settled wagers to canonical history: %s", (text) => {
    expect(wagerHistoryRouteForPrompt(configuredWallets(), text)).toEqual({
      toolName: "getWagerHistory",
      owner: null,
    });
  });

  it.each([
    "if I win this wager, what is the payout?",
    "bet $5 on heads",
    "why do people win at poker?",
    "show a fictional wager history",
  ])("does not capture current, hypothetical, or unrelated wager discussion: %s", (text) => {
    expect(wagerHistoryRouteForPrompt(configuredWallets(), text)).toBeNull();
  });
});
