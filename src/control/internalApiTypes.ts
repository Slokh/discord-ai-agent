import type http from "node:http";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { PaymentRepository } from "../db/paymentRepository.js";
import type { DbPool } from "../db/pool.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";

export type InternalApiInput = {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntimeRepo?: AgentRuntimeRepository;
  paymentRepo?: PaymentRepository;
  db?: DbPool;
  jobs?: Pick<JobRuntime, "enqueueAgentRuntimeExecution">;
  request: http.IncomingMessage;
  response: http.ServerResponse;
};
