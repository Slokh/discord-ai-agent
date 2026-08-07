import type { AppConfig } from "../config/env.js";
import { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import { BudgetRepository } from "../db/budgetRepository.js";
import { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import { PaymentRepository } from "../db/paymentRepository.js";
import { OperatorDashboardRepository } from "../db/operatorDashboardRepository.js";
import { createPool } from "../db/pool.js";
import { createAppDatabase } from "../db/repositories.js";
import { RngRepository } from "../db/rngRepository.js";
import { ServiceHeartbeatRepository } from "../db/serviceHeartbeatRepository.js";
import { OpenRouterClient } from "../models/openrouter.js";
import { PrivyTempoWalletProvider } from "../payments/privyTempoWalletProvider.js";
import { WalletService } from "../payments/walletService.js";

/** Process-agnostic composition root for application-owned services. */
export function createApplicationServices(input: {
  config: AppConfig;
  enableWalletRuntime: boolean;
}) {
  const { config } = input;
  const pool = createPool(config);
  const repo = createAppDatabase(pool);
  const agentRuntime = new AgentRuntimeRepository(pool);
  const budget = new BudgetRepository(pool);
  const rng = new RngRepository(pool);
  const payments = new PaymentRepository(pool);
  const deliveryObligations = new DeliveryObligationsRepository(pool);
  const operatorDashboard = new OperatorDashboardRepository(pool);
  const serviceHeartbeats = new ServiceHeartbeatRepository(pool);
  const openRouter = new OpenRouterClient(config.openRouter);
  const walletProvider = input.enableWalletRuntime && config.payments.walletEnabled
    ? new PrivyTempoWalletProvider({
        appId: config.payments.privyAppId!,
        appSecret: config.payments.privyAppSecret!,
        network: config.payments.tempoNetwork,
      })
    : undefined;
  const wallet = walletProvider
    ? new WalletService(config.payments, payments, walletProvider)
    : undefined;

  return {
    pool,
    repo,
    agentRuntime,
    budget,
    rng,
    payments,
    deliveryObligations,
    operatorDashboard,
    serviceHeartbeats,
    openRouter,
    wallet,
    close: () => pool.end(),
  };
}
