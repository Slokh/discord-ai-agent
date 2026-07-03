import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { DiscordAiAgentRepository } from "../db/repositories.js";
import { OpenRouterClient } from "../models/openrouter.js";
import { executeSandboxPromptRequest } from "./sandboxPromptCore.js";
import type { SandboxPromptRequest } from "./sandboxPromptProtocol.js";

async function main() {
  const input = JSON.parse(await readStdin()) as SandboxPromptRequest;
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const repo = new DiscordAiAgentRepository(pool);
    const openRouter = new OpenRouterClient(config.openRouter);
    const response = await executeSandboxPromptRequest({
      config,
      repo,
      openRouter,
      request: input
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
