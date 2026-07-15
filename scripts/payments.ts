import { randomUUID } from "node:crypto";
import { assertPaymentConfig, loadConfig } from "../src/config/env.js";
import { PaymentRepository } from "../src/db/paymentRepository.js";
import { createPool } from "../src/db/pool.js";
import { PrivyTempoWalletProvider } from "../src/payments/privyTempoWalletProvider.js";
import { MppService } from "../src/payments/mppService.js";
import { WalletService } from "../src/payments/walletService.js";

async function main() {
  const command = process.argv[2] ?? "status";
  const config = loadConfig();
  const pool = createPool(config);
  const repo = new PaymentRepository(pool);
  try {
    if (command === "status") {
      if (config.payments.walletEnabled && config.payments.privyAppId && config.payments.privyAppSecret) {
        const provider = new PrivyTempoWalletProvider({
          appId: config.payments.privyAppId,
          appSecret: config.payments.privyAppSecret,
          network: config.payments.tempoNetwork
        });
        const service = new WalletService(config.payments, repo, provider);
        await service.recordBotWalletHealth();
      }
      process.stdout.write(`${JSON.stringify(await repo.getPaymentsConsoleSnapshot({ limit: 25 }), null, 2)}\n`);
      return;
    }
    if (command === "reconcile" || command === "provision-bot" || command === "mpp-smoke") {
      assertPaymentConfig(config);
      const provider = new PrivyTempoWalletProvider({
        appId: config.payments.privyAppId,
        appSecret: config.payments.privyAppSecret,
        network: config.payments.tempoNetwork
      });
      const service = new WalletService(config.payments, repo, provider);
      if (command === "reconcile") {
        process.stdout.write(`${JSON.stringify(await service.reconcile())}\n`);
        return;
      }
      if (command === "mpp-smoke") {
        if (!config.payments.mppEnabled) throw new Error("MPP_ENABLED must be true for the MPP smoke test");
        const options = parseOptions(process.argv.slice(3));
        const serviceRef = requiredOption(options, "service");
        const mpp = new MppService(config.payments, repo, service);
        const inspection = await mpp.inspect(serviceRef);
        process.stdout.write(`${inspection}\n`);
        if (!options.has("confirm-spend")) {
          process.stdout.write("\nInspection only; no payment was attempted. Re-run with --operation <id> --confirm-spend to execute one bounded call.\n");
          return;
        }
        if (config.payments.tempoNetwork === "mainnet" && !options.has("allow-mainnet")) {
          throw new Error("Refusing a mainnet smoke payment without --allow-mainnet");
        }
        const inspectionId = inspection.match(/Inspection ID: (mppi_[^\s]+)/)?.[1];
        if (!inspectionId) throw new Error("Could not read the generated inspection ID");
        const operatorAuthorization = "confirm this bounded MPP smoke payment";
        const response = await mpp.call({
          guildId: config.discord.guildId || "__operator_smoke__",
          userId: "__operator_smoke__",
          executionId: `smoke_${randomUUID()}`,
          requestText: operatorAuthorization
        }, {
          inspectionId,
          operationId: requiredOption(options, "operation"),
          pathParams: jsonRecordOption(options, "path-json"),
          query: jsonRecordOption(options, "query-json"),
          body: jsonOption(options, "body-json"),
          expectedResponseType: options.get("expected") ?? "json",
          effect: options.get("effect") === "external_side_effect" ? "external_side_effect" : "read_only",
          userAuthorization: operatorAuthorization,
          allowRepeat: options.has("allow-repeat")
        });
        process.stdout.write(`${JSON.stringify({
          status: response.status,
          errorCode: response.errorCode,
          retryable: response.retryable,
          content: response.content,
          files: response.files?.map((file) => ({ name: file.name, contentType: file.contentType, bytes: file.data.length })) ?? []
        }, null, 2)}\n`);
        return;
      }
      const wallet = await service.ensureBotWallet(config.discord.guildId);
      const balance = await service.getBalance(wallet);
      process.stdout.write(
        `${JSON.stringify({
          walletId: wallet.id,
          address: wallet.address,
          network: config.payments.tempoNetwork,
          chainId: wallet.chainId,
          token: balance.token.symbol,
          balance: balance.formatted
        }, null, 2)}\n`
      );
      return;
    }
    throw new Error(`Unknown payments command ${command}; expected status, reconcile, provision-bot, or mpp-smoke`);
  } finally {
    await pool.end();
  }
}

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (!raw?.startsWith("--")) throw new Error(`Unexpected argument ${raw ?? ""}`);
    const name = raw.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) options.set(name, "true");
    else {
      options.set(name, next);
      index += 1;
    }
  }
  return options;
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value || value === "true") throw new Error(`--${name} is required`);
  return value;
}

function jsonOption(options: Map<string, string>, name: string): unknown {
  const value = options.get(name);
  if (!value) return undefined;
  return JSON.parse(value);
}

function jsonRecordOption(options: Map<string, string>, name: string): Record<string, unknown> | undefined {
  const value = jsonOption(options, name);
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`--${name} must be a JSON object`);
  return value as Record<string, unknown>;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
