import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { handleAgentRequest } from "./router.js";
import { conversationMessagesFromEnvelope, serializeAgentResponse, type SandboxPromptRequest, type SandboxPromptResponse } from "./sandboxPromptProtocol.js";

export async function executeSandboxPromptRequest(input: {
  request: SandboxPromptRequest;
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  openRouter: OpenRouterClient;
  jobs?: JobRuntime;
}): Promise<SandboxPromptResponse> {
  const envelope = input.request.envelope;
  const toolContext: ToolContext = {
    config: input.config,
    repo: input.repo,
    openRouter: input.openRouter,
    jobs: input.jobs,
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

  return serializeAgentResponse(await handleAgentRequest(toolContext, envelope.text));
}
