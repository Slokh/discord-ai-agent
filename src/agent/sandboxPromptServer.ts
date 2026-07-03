import "dotenv/config";
import http from "node:http";
import { loadConfig, type AppConfig } from "../config/env.js";
import { CodegenRepository } from "../db/codegenRepository.js";
import { createPool } from "../db/pool.js";
import { DiscordAiAgentRepository } from "../db/repositories.js";
import type { DbPool } from "../db/pool.js";
import { startJobs, type JobRuntime } from "../jobs/queue.js";
import { OpenRouterClient } from "../models/openrouter.js";
import { logger } from "../util/logger.js";
import { executeSandboxPromptRequest } from "./sandboxPromptCore.js";
import type { SandboxPromptRequest } from "./sandboxPromptProtocol.js";

const MAX_BODY_BYTES = 25 * 1024 * 1024;

export type SandboxPromptServerRuntime = {
  close: () => Promise<void>;
  url: string;
};

export async function startSandboxPromptServer(input: {
  config?: AppConfig;
  repo?: DiscordAiAgentRepository;
  openRouter?: OpenRouterClient;
  jobs?: JobRuntime;
  close?: () => Promise<void>;
} = {}): Promise<SandboxPromptServerRuntime> {
  const config = input.config ?? loadConfig();
  let pool: DbPool | undefined;
  let codegenPool: DbPool | undefined;
  const repo =
    input.repo ??
    (() => {
      pool = createPool(config);
      return new DiscordAiAgentRepository(pool);
    })();
  const openRouter = input.openRouter ?? new OpenRouterClient(config.openRouter);
  const jobs =
    input.jobs ??
    (await startJobs({
      config,
      repo,
      codegenRepo: new CodegenRepository(pool ?? (codegenPool = createPool(config))),
      crawler: {
        crawlConfiguredGuild: async () => {
          throw new Error("Crawl jobs are unavailable in the warm sandbox prompt server.");
        }
      },
      worker: false,
      crawlWorker: false,
      embeddingWorker: false,
      taskWorker: false,
      discordAgentWorker: false
    }));
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/execute") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const body = (await readJsonBody(request)) as SandboxPromptRequest;
      sendJson(response, 200, await executeSandboxPromptRequest({ request: body, config, repo, openRouter, jobs }));
    } catch (error) {
      logger.error({ err: error }, "Sandbox prompt server request failed");
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.agentRuntime.warmSandboxPort, config.agentRuntime.warmSandboxHost, resolve);
  });
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : config.agentRuntime.warmSandboxPort;
  logger.info({ host: config.agentRuntime.warmSandboxHost, port: actualPort }, "Warm sandbox prompt server is listening");

  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(async (error) => {
          await input.close?.().catch(() => undefined);
          if (!input.jobs) await jobs.stop().catch(() => undefined);
          await pool?.end().catch(() => undefined);
          await codegenPool?.end().catch(() => undefined);
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSandboxPromptServer().catch((error) => {
    logger.error({ err: error }, "Warm sandbox prompt server failed to start");
    process.exit(1);
  });
}
