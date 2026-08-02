import type { Client } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { BudgetRepository } from "../db/budgetRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { RngRepository } from "../db/rngRepository.js";
import type { AgentRuntimeExecutionRunner } from "../jobs/queue.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { WalletService } from "../payments/walletService.js";
import { NanoCodexAgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import { runQueuedAgentRuntimeExecution } from "./agentDelivery.js";

/** Composes Discord delivery and installed feature services around the generic agent executor. */
export function createAgentRuntimeRunner(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  budgetRepo?: BudgetRepository;
  rngRepo?: RngRepository;
  walletService?: WalletService;
  agentRuntimeRepo: AgentRuntimeRepository;
  deliveryObligations?: DeliveryObligationsRepository;
  openRouter: OpenRouterClient;
  client: Client;
}): AgentRuntimeExecutionRunner {
  const agentExecutor = new NanoCodexAgentRuntimePromptExecutor();
  return {
    run: async (job, context) => {
      await runQueuedAgentRuntimeExecution(
        {
          config: input.config,
          repo: input.repo,
          budgetRepo: input.budgetRepo,
          rngRepo: input.rngRepo,
          walletService: input.walletService,
          agentRuntime: input.agentRuntimeRepo,
          deliveryObligations: input.deliveryObligations,
          agentExecutor,
          openRouter: input.openRouter,
          jobs: context.jobs,
          client: input.client
        },
        job
      );
    }
  };
}
