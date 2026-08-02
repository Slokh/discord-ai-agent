import { assertPaymentConfig, loadConfig } from "../src/config/env.js";
import { PaymentRepository } from "../src/db/paymentRepository.js";
import { createPool } from "../src/db/pool.js";
import { atomicToUsd, safeUsdNumber, usdToAtomic } from "../src/payments/money.js";
import { PrivyTempoWalletProvider } from "../src/payments/privyTempoWalletProvider.js";
import { planWalletRebalance, verifyWalletRebalance } from "../src/payments/walletRebalance.js";
import { WalletService } from "../src/payments/walletService.js";

async function main() {
  const command = process.argv[2] ?? "status";
  const config = loadConfig();
  const pool = createPool(config);
  const repo = new PaymentRepository(pool);
  try {
    if (command === "status") {
      if (config.payments.walletEnabled && config.payments.privyAppId && config.payments.privyAppSecret) {
        const service = walletService();
        await service.recordBotWalletHealth();
      }
      process.stdout.write(`${JSON.stringify(await repo.getPaymentsConsoleSnapshot({ limit: 25 }), null, 2)}\n`);
      return;
    }
    if (command === "rebalance") {
      assertPaymentConfig(config);
      if (!config.payments.walletEnabled || !config.payments.userWalletsEnabled) {
        throw new Error("Wallet rebalancing requires complete Privy credentials.");
      }
      const requestedByUserId = config.allowlists.ownerUserId;
      if (!requestedByUserId) throw new Error("BOT_OWNER_USER_ID is required to attribute a wallet rebalance");
      const options = parseRebalanceOptions(process.argv.slice(3));
      const service = walletService();
      const activity = paymentActivity(await repo.getPaymentsConsoleSnapshot({
        guildId: config.discord.guildId,
        limit: 1,
      }));
      const [bot, users] = await Promise.all([
        service.getBotWalletSummary(config.discord.guildId),
        service.listExistingUserWalletSummaries({ guildId: config.discord.guildId }),
      ]);
      const unavailable = users.filter((user) => !user.balance || user.wallet.status !== "active");
      if (unavailable.length > 0) {
        throw new Error(`${unavailable.length} user wallet balance(s) could not be verified; no rebalance was attempted`);
      }
      const tokenDecimals = bot.balance.token.decimals;
      const targetAtomic = usdToAtomic(config.payments.initialGrantUsd, tokenDecimals);
      const plan = planWalletRebalance({
        botBalanceAtomic: bot.balance.amountAtomic,
        users: users.map((user) => ({
          userId: user.userId,
          walletId: user.wallet.id,
          balanceAtomic: user.balance!.amountAtomic,
        })),
        targetAtomic,
      });
      const summary = {
        mode: options.execute ? "execute" : "dry_run",
        network: config.payments.tempoNetwork,
        token: bot.balance.token.symbol,
        targetUsd: atomicToUsd(targetAtomic, tokenDecimals),
        userWallets: users.length,
        collectFromUsers: plan.collect.length,
        fundUsers: plan.distribute.length,
        unchangedUsers: plan.unchangedUsers,
        totalManagedUsd: atomicToUsd(plan.totalAtomic, tokenDecimals),
        aiStartingUsd: atomicToUsd(plan.botStartingAtomic, tokenDecimals),
        aiProjectedBeforeFeesUsd: atomicToUsd(plan.botProjectedAtomic, tokenDecimals),
        pendingTransfers: activity.pendingTransfers,
        openWagers: activity.openWagers,
      };
      if (!options.execute) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return;
      }
      if (!options.batchId) throw new Error("--batch-id is required with --execute");
      if (activity.pendingTransfers > 0 || activity.openWagers > 0) {
        throw new Error("Wallet rebalance requires zero pending transfers and zero open wagers");
      }

      const reason = `Server wallet rebalance to $${summary.targetUsd} per user (batch ${options.batchId})`;
      let receiptVerifiedAiBalanceAtomic = bot.balance.amountAtomic;
      for (const movement of plan.collect) {
        const result = await service.transferAsAdmin({
          guildId: config.discord.guildId,
          requestedByUserId,
          source: { kind: "user", userId: movement.userId },
          destination: { kind: "bot" },
          amountUsd: safeUsdNumber(movement.amountAtomic, tokenDecimals),
          requestId: `wallet-rebalance:${options.batchId}:collect:${movement.walletId}`,
          reason,
        });
        if (result.destination.balance) {
          receiptVerifiedAiBalanceAtomic = usdToAtomic(result.destination.balance.formatted, tokenDecimals);
        }
      }
      for (const movement of plan.distribute) {
        const result = await service.transferAsAdmin({
          guildId: config.discord.guildId,
          requestedByUserId,
          source: { kind: "bot" },
          destination: { kind: "user", userId: movement.userId },
          amountUsd: safeUsdNumber(movement.amountAtomic, tokenDecimals),
          requestId: `wallet-rebalance:${options.batchId}:distribute:${movement.walletId}`,
          reason,
        });
        if (result.source.balance) {
          receiptVerifiedAiBalanceAtomic = usdToAtomic(result.source.balance.formatted, tokenDecimals);
        }
      }

      const [finalBot, finalUsers] = await Promise.all([
        service.getBotWalletSummary(config.discord.guildId),
        service.listExistingUserWalletSummaries({ guildId: config.discord.guildId }),
      ]);
      const { networkFeesAtomic } = verifyWalletRebalance({
        targetAtomic,
        userBalancesAtomic: finalUsers.map((user) => user.balance?.amountAtomic ?? -1n),
        finalBotBalanceAtomic: finalBot.balance.amountAtomic,
        receiptBotBalanceAtomic: receiptVerifiedAiBalanceAtomic,
        projectedBotBalanceBeforeFeesAtomic: plan.botProjectedAtomic,
      });
      process.stdout.write(`${JSON.stringify({
        ...summary,
        mode: "executed",
        batchId: options.batchId,
        transfersConfirmed: plan.collect.length + plan.distribute.length,
        aiFinalUsd: finalBot.balance.formatted,
        networkFeesUsd: atomicToUsd(networkFeesAtomic, tokenDecimals),
        verifiedUserWallets: finalUsers.length,
      }, null, 2)}\n`);
      return;
    }
    if (command === "reconcile" || command === "provision-bot") {
      assertPaymentConfig(config);
      const service = walletService();
      if (command === "reconcile") {
        process.stdout.write(`${JSON.stringify(await service.reconcile())}\n`);
        return;
      }
      const wallet = await service.ensureBotWallet(config.discord.guildId);
      const balance = await service.getBalance(wallet);
      process.stdout.write(`${JSON.stringify({
        walletId: wallet.id,
        address: wallet.address,
        network: config.payments.tempoNetwork,
        chainId: wallet.chainId,
        token: balance.token.symbol,
        balance: balance.formatted
      }, null, 2)}\n`);
      return;
    }
    throw new Error(`Unknown payments command ${command}; expected status, rebalance, reconcile, or provision-bot`);
  } finally {
    await pool.end();
  }

  function walletService() {
    assertPaymentConfig(config);
    return new WalletService(config.payments, repo, new PrivyTempoWalletProvider({
      appId: config.payments.privyAppId,
      appSecret: config.payments.privyAppSecret,
      network: config.payments.tempoNetwork
    }));
  }
}

function parseRebalanceOptions(args: string[]): { execute: boolean; batchId: string | null } {
  let execute = false;
  let batchId: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (argument === "--batch-id") {
      batchId = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown rebalance option ${argument}`);
  }
  if (batchId && !/^[A-Za-z0-9._-]{1,80}$/.test(batchId)) {
    throw new Error("--batch-id must contain only letters, numbers, dots, underscores, or hyphens");
  }
  return { execute, batchId };
}

function paymentActivity(snapshot: Record<string, unknown>): { pendingTransfers: number; openWagers: number } {
  const totals = snapshot.totals && typeof snapshot.totals === "object"
    ? snapshot.totals as Record<string, unknown>
    : {};
  return {
    pendingTransfers: nonNegativeInteger(totals.transfers_pending),
    openWagers: nonNegativeInteger(totals.wagers_open),
  };
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Payment activity counts could not be verified");
  }
  return parsed;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
