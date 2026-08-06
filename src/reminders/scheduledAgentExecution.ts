import type { Client, Message, MessageCreateOptions } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { BudgetRepository } from "../db/budgetRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository, ScheduledReminder } from "../db/repositories.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { RngRepository } from "../db/rngRepository.js";
import type { WalletService } from "../payments/walletService.js";
import { executeDiscordAgentRequest } from "../discord/agentDelivery.js";
import { fetchDiscordMessage } from "../discord/requestContext.js";
import { DiscordResponseSink, sendDiscordNotification } from "../discord/responseSink.js";
import { logger } from "../util/logger.js";

export type ScheduledAgentRequestRunner = {
  execute: (
    reminder: ScheduledReminder,
    channel: { send: (payload: MessageCreateOptions) => Promise<Message> },
    requesterDisplayName: string,
  ) => Promise<Message>;
};

export function createScheduledAgentRequestRunner(input: {
  client: Client;
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  agentRuntime?: AgentRuntimeRepository;
  deliveryObligations?: DeliveryObligationsRepository;
  budgetRepo?: BudgetRepository;
  rngRepo?: RngRepository;
  walletService?: WalletService;
  openRouter: OpenRouterClient;
  jobs?: JobRuntime;
  executeAgent?: typeof executeDiscordAgentRequest;
}): ScheduledAgentRequestRunner {
  return {
    execute: async (reminder, channel, requesterDisplayName) => {
      const identity = scheduledAgentOccurrenceIdentity(reminder);
      const retained = await input.deliveryObligations?.getByExecutionId(identity.executionId).catch(() => undefined);
      if (retained?.state === "delivered" && retained.statusChannelId && retained.statusMessageId) {
        return {
          id: retained.statusMessageId,
          channelId: retained.statusChannelId,
          url: typeof retained.metadata?.replyUrl === "string" ? retained.metadata.replyUrl : "",
        } as Message;
      }

      const requestLogger = logger.child({
        traceId: identity.requestId,
        requestId: identity.requestId,
        guildId: reminder.guildId,
        channelId: reminder.channelId,
        userId: reminder.requesterId,
        reminderId: reminder.reminderId,
        occurrenceSequence: reminder.occurrenceSequence,
      });
      const pendingMessage = retained?.statusChannelId && retained.statusMessageId
        ? await fetchDiscordMessage(input.client, retained.statusChannelId, retained.statusMessageId).catch(() => null)
        : null;
      const statusMessage = pendingMessage ?? await sendDiscordNotification({
        channel,
        content: `<@${reminder.requesterId}> running your scheduled request…`,
        mentionUserId: reminder.requesterId,
        deliveryKey: identity.deliveryKey,
        maxChars: input.config.maxReplyChars,
        logger: requestLogger,
      });
      const responseSink = new DiscordResponseSink({
        client: input.client,
        sourceMessage: statusMessage,
        statusMessage,
        maxReplyChars: input.config.maxReplyChars,
        loadingReactionEmoji: input.config.discord.loadingReaction,
        deliveryKey: identity.deliveryKey,
        logger: requestLogger,
      });
      const result = await (input.executeAgent ?? executeDiscordAgentRequest)(
        {
          config: input.config,
          repo: input.repo,
          budgetRepo: input.budgetRepo,
          rngRepo: input.rngRepo,
          walletService: input.walletService,
          agentRuntime: input.agentRuntime,
          deliveryObligations: input.deliveryObligations,
          openRouter: input.openRouter,
          jobs: input.jobs,
        },
        input.client,
        statusMessage,
        responseSink,
        {
          requestId: identity.requestId,
          agentSessionId: identity.sessionId,
          agentExecutionId: identity.executionId,
          text: reminder.reminderText,
          rawContent: reminder.reminderText,
          botRoleIds: [],
          messageStartedAt: Date.now(),
          requestKind: "scheduled",
          userId: reminder.requesterId,
          userDisplayName: requesterDisplayName,
        },
      );
      return result.message;
    },
  };
}

export function scheduledAgentOccurrenceIdentity(reminder: Pick<ScheduledReminder, "reminderId" | "occurrenceSequence">) {
  const occurrence = `${reminder.reminderId}:${reminder.occurrenceSequence}`;
  return {
    requestId: `scheduled-request:${occurrence}`,
    sessionId: `scheduled-request-session:${reminder.reminderId}`,
    executionId: `scheduled-request-execution:${occurrence}`,
    deliveryKey: `scheduled-request:${occurrence}`,
  };
}
