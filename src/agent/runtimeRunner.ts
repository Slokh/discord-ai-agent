import type { Client } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { runQueuedAgentRuntimeExecution } from "../discord/client.js";
import type { AgentRuntimeExecutionRunner } from "../jobs/queue.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { InProcessAgentRuntimePromptExecutor, WarmSandboxAgentRuntimePromptExecutor } from "./runtimeExecutor.js";

export function createAgentRuntimeRunner(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntimeRepo: AgentRuntimeRepository;
  openRouter: OpenRouterClient;
  client: Client;
}): AgentRuntimeExecutionRunner {
  const agentExecutor =
    input.config.agentRuntime.executionBackend === "warm-sandbox"
      ? new WarmSandboxAgentRuntimePromptExecutor({ warmSandboxUrl: input.config.agentRuntime.warmSandboxUrl })
      : new InProcessAgentRuntimePromptExecutor();
  return {
    run: async (job, context) => {
      await runQueuedAgentRuntimeExecution(
        {
          config: input.config,
          repo: input.repo,
          agentRuntime: input.agentRuntimeRepo,
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
