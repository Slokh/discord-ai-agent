import { assertPaymentConfig, loadConfig } from "../src/config/env.js";
import { PaymentRepository } from "../src/db/paymentRepository.js";
import { createPool } from "../src/db/pool.js";
import { PrivyTempoWalletProvider } from "../src/payments/privyTempoWalletProvider.js";
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
    throw new Error(`Unknown payments command ${command}; expected status, reconcile, or provision-bot`);
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
