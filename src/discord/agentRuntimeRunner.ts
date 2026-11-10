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
import type { AgentRuntimeExecutionJob } from "../jobs/queue.js";
import { NanoCodexAgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import { steerActiveTurn } from "../agent/nanocodexAgentRuntime.js";
import { logger } from "../util/logger.js";
import { runQueuedAgentRuntimeExecution } from "./agentDelivery.js";
import { discordReact, discordRemoveReaction } from "./api.js";
import { discordChannelThreadKey } from "./mentionParsing.js";

/** Reaction on a follow-up that joined the requester's running turn. */
export const STEERED_REACTION = "👀";

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
    steer: async (job) => steerFollowUp(input, job),
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

/**
 * Joins a follow-up to the requester's running turn. Its own execution and
 * delivery obligation close here, so the delivery sweep never answers it
 * separately; the running turn's reply answers both messages.
 */
async function steerFollowUp(
  input: Parameters<typeof createAgentRuntimeRunner>[0],
  job: AgentRuntimeExecutionJob,
): Promise<boolean> {
  if (!job.agentExecutionId || !job.agentSessionId) return false;
  const steeredInto = await steerActiveTurn({
    threadKey: job.agentThreadKey ?? discordChannelThreadKey(job.guildId, job.channelId),
    userId: job.userId,
    userDisplayName: job.requesterDisplayName,
    steerId: job.runId,
    text: job.text,
  });
  if (!steeredInto) return false;
  await input.agentRuntimeRepo.updateExecution({
    executionId: job.agentExecutionId,
    status: "succeeded",
    metadata: { steeredIntoRequestId: steeredInto },
  });
  await input.agentRuntimeRepo.recordEvent({
    sessionId: job.agentSessionId,
    executionId: job.agentExecutionId,
    traceId: job.traceId ?? job.runId,
    kind: "status",
    eventName: "agent.execution.steered",
    summary: "Follow-up joined the requester's running turn.",
    metadata: { steeredIntoRequestId: steeredInto },
  });
  await input.deliveryObligations?.markDelivered({
    executionId: job.agentExecutionId,
    metadata: { steeredIntoRequestId: steeredInto },
  });
  await markSteeredMessage(input, job).catch((error) =>
    logger.warn({ err: error, messageId: job.messageId }, "Failed to mark a steered follow-up in Discord"));
  return true;
}

async function markSteeredMessage(input: Parameters<typeof createAgentRuntimeRunner>[0], job: AgentRuntimeExecutionJob) {
  const channel = await input.client.channels.fetch(job.channelId);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(job.messageId);
  const botUserId = input.client.user?.id;
  const loading = message.reactions.cache.get(input.config.discord.loadingReaction);
  if (loading && botUserId) await discordRemoveReaction(loading, botUserId, { logger });
  await discordReact(message, STEERED_REACTION, { logger });
}
