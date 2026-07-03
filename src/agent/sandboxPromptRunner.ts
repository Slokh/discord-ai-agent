import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { DiscordAiAgentRepository } from "../db/repositories.js";
import { OpenRouterClient } from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { handleAgentRequest } from "./router.js";
import { conversationMessagesFromEnvelope, serializeAgentResponse, type SandboxPromptRequest } from "./sandboxPromptProtocol.js";

async function main() {
  const input = JSON.parse(await readStdin()) as SandboxPromptRequest;
  const envelope = input.envelope;
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const repo = new DiscordAiAgentRepository(pool);
    const openRouter = new OpenRouterClient(config.openRouter);
    const toolContext: ToolContext = {
      config,
      repo,
      openRouter,
      guildId: envelope.guildId,
      channelId: envelope.channelId,
      userId: envelope.userId,
      userDisplayName: envelope.userDisplayName,
      visibleChannelIds: envelope.visibleChannelIds,
      mentionedUserIds: envelope.mentionedUserIds,
      mentionedChannelIds: envelope.mentionedChannelIds,
      threadKey: envelope.threadKey,
      sessionMessages: conversationMessagesFromEnvelope(envelope),
      replyContext: envelope.replyContext ?? undefined,
      requestAttachments: envelope.requestAttachments,
      requestId: envelope.requestId,
      statusChannelId: envelope.delivery.statusChannelId ?? undefined,
      statusMessageId: envelope.delivery.statusMessageId ?? undefined
    };

    const response = await handleAgentRequest(toolContext, envelope.text);
    process.stdout.write(`${JSON.stringify(serializeAgentResponse(response))}\n`);
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
