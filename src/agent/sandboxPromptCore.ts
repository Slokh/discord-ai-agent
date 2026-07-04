import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { handleAgentRequest } from "./router.js";
import {
  conversationMessagesFromEnvelope,
  promptTextFromAgentRuntimeInputLines,
  serializeAgentResponse,
  type SandboxPromptRequest,
  type SandboxPromptResponse
} from "./sandboxPromptProtocol.js";

export async function executeSandboxPromptRequest(input: {
  request: SandboxPromptRequest;
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  openRouter: OpenRouterClient;
  jobs?: JobRuntime;
}): Promise<SandboxPromptResponse> {
  const envelope = input.request.envelope;
  const agentRuntimeSession = input.agentRuntime ? await input.agentRuntime.getSession({ threadKey: envelope.threadKey }) : null;
  const toolContext: ToolContext = {
    config: input.config,
    repo: input.repo,
    agentRuntime: input.agentRuntime,
    agentRuntimeSession: agentRuntimeSession ?? null,
    agentRuntimeExecutionId: null,
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

  return serializeAgentResponse(await handleAgentRequest(toolContext, promptTextFromAgentRuntimeInputLines(input.request.inputLines) ?? envelope.text));
}
