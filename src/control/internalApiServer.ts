import http from "node:http";
import type { AppConfig } from "../config/env.js";
import { assertTaskCallbackConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DbPool } from "../db/pool.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { PaymentRepository } from "../db/paymentRepository.js";
import { logger } from "../util/logger.js";
import { handleInternalApiRequest } from "./internalApi.js";
import { sendJson } from "./internalApiHttp.js";

export type InternalApiRuntime = {
  close: () => Promise<void>;
  url: string;
};

export async function startInternalApi(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntimeRepo?: AgentRuntimeRepository;
  paymentRepo?: PaymentRepository;
  db?: DbPool;
  jobs?: Pick<JobRuntime, "enqueueAgentRuntimeExecution">;
}): Promise<InternalApiRuntime> {
  assertTaskCallbackConfig(input.config);
  const server = http.createServer(async (request, response) => {
    try {
      await handleInternalApiRequest({ ...input, request, response });
    } catch (error) {
      logger.error({ err: error }, "Internal API request failed");
      sendJson(response, 500, { error: "internal_error" });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(
      input.config.internalApi.port,
      input.config.internalApi.host,
      resolve,
    );
  });
  const address = server.address();
  const actualPort =
    address && typeof address === "object"
      ? address.port
      : input.config.internalApi.port;
  logger.info(
    { host: input.config.internalApi.host, port: actualPort },
    "Internal task callback API is listening",
  );

  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
