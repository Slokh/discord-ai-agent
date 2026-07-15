import { Client, Events, GatewayIntentBits, MessageFlags, Partials, type Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { BudgetRepository } from "../db/budgetRepository.js";
import type { RngRepository } from "../db/rngRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { AgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import type { WalletService } from "../payments/walletService.js";
import type { DiscordCrawler } from "./crawler.js";
import { persistDiscordMessage } from "./messagePersistence.js";
import { sweepDiscordDeliveryObligations } from "./deliverySweep.js";
import { handleMessageCreate, queueIncomingMessageEmbedding } from "./messageIngress.js";
import { handleRegenerateReplyReaction, handleUndoCrossReaction, persistReactionMessage, persistReactionMessageUpdate } from "./reactions.js";
import { deletedMessageIdsForConfiguredGuild, isSelfMessage, isSelfUser, shouldProcessGuildEvent } from "./mentionParsing.js";
import { discordMessageTraceContext, recordTraceEvent } from "./requestContext.js";
import { logger } from "../util/logger.js";
import { runWithTrace } from "../util/trace.js";

export type DiscordAiAgentBotRuntime = {
  client: Client;
  login: () => Promise<void>;
  drain: (timeoutMs?: number) => Promise<void>;
  destroy: () => void;
};

export function createDiscordAiAgentBot(input: {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  budgetRepo?: BudgetRepository;
  rngRepo?: RngRepository;
  walletService?: WalletService;
  agentRuntime?: AgentRuntimeRepository;
  deliveryObligations?: DeliveryObligationsRepository;
  agentExecutor?: AgentRuntimePromptExecutor;
  openRouter: OpenRouterClient;
  crawler: DiscordCrawler;
  jobs?: JobRuntime;
  client?: Client;
}): DiscordAiAgentBotRuntime {
  const client =
    input.client ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });
  let acceptingMessages = true;
  const activeMessageHandlers = new Set<Promise<void>>();

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        tag: readyClient.user.tag,
        userId: readyClient.user.id,
        guildCount: readyClient.guilds.cache.size
      },
      "Discord AI Agent Discord bot is online"
    );
    if (input.deliveryObligations && input.agentRuntime) {
      void sweepDiscordDeliveryObligations({
        client: readyClient,
        obligations: input.deliveryObligations,
        agentRuntime: input.agentRuntime,
        logger,
        maxReplyChars: input.config.maxReplyChars
      }).catch((error) => logger.warn({ err: error }, "Discord delivery obligation startup sweep failed"));
    }
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn({ shardId, code: event?.code, reason: event?.reason, wasClean: event?.wasClean }, "Discord shard disconnected");
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    logger.info({ shardId }, "Discord shard reconnecting");
  });
  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info({ shardId, replayedEvents }, "Discord shard resumed");
  });
  client.on(Events.ShardError, (error, shardId) => {
    logger.warn({ err: error, shardId }, "Discord shard error");
  });
  client.on(Events.Invalidated, () => {
    logger.warn("Discord client session invalidated");
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!acceptingMessages) {
      logger.info({ messageId: message.id, channelId: message.channelId }, "Ignoring Discord message while bot is draining");
      return;
    }
    const handler = runWithTrace(discordMessageTraceContext(message), async () => {
      await handleMessageCreate(input, client, message).catch((error) => {
        logger.error({ err: error, messageId: message.id }, "Message handler failed");
      });
    });
    activeMessageHandlers.add(handler);
    try {
      await handler;
    } finally {
      activeMessageHandlers.delete(handler);
    }
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    await runWithTrace(discordMessageTraceContext(newMessage), async () => {
      try {
        const fetched = newMessage.partial ? await newMessage.fetch() : newMessage;
        if (fetched.inGuild()) {
          if (!shouldProcessGuildEvent(input.config.discord.guildId, fetched.guildId)) return;
          if (isSelfMessage(fetched as Message, client.user?.id)) return;
          await persistDiscordMessage(input.repo, fetched as Message);
          queueIncomingMessageEmbedding(input, fetched as Message, client.user?.id, "message_update");
          await recordTraceEvent(input.repo, { eventName: "discord.message.updated", summary: "Persisted edited Discord message" });
        }
      } catch (error) {
        logger.warn({ err: error }, "Failed to persist message update");
      }
    });
  });

  client.on(Events.MessageDelete, async (message) => {
    await runWithTrace(discordMessageTraceContext(message), async () => {
      if (!shouldProcessGuildEvent(input.config.discord.guildId, message.guildId)) return;
      if (message.id) await input.repo.markMessageDeleted(message.id).catch(() => undefined);
      await recordTraceEvent(input.repo, { eventName: "discord.message.deleted", summary: "Marked Discord message deleted" });
    });
  });

  client.on(Events.MessageBulkDelete, async (messages) => {
    const messageIds = deletedMessageIdsForConfiguredGuild(messages.values(), input.config.discord.guildId);
    await Promise.all(messageIds.map((messageId) => input.repo.markMessageDeleted(messageId).catch(() => undefined)));
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      if (user && !isSelfUser(user, client.user?.id)) {
        const handled = await handleUndoCrossReaction(input, client, reaction, user).catch((error) => {
          logger.warn({ err: error }, "Failed to handle ❌ undo reaction");
          return false;
        });
        if (handled) return;
      }
      await Promise.all([
        persistReactionMessageUpdate(input, reaction).catch((error) => {
          logger.warn({ err: error }, "Failed to persist reaction add");
        }),
        handleRegenerateReplyReaction(input, client, reaction, user).catch((error) => {
          logger.warn({ err: error }, "Failed to handle regenerate reply reaction");
        })
      ]);
    });
  });

  client.on(Events.MessageReactionRemove, async (reaction) => {
    await runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      await persistReactionMessageUpdate(input, reaction).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction remove");
      });
    });
  });

  client.on(Events.MessageReactionRemoveEmoji, async (reaction) => {
    await runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      await persistReactionMessageUpdate(input, reaction).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction emoji removal");
      });
    });
  });

  client.on(Events.MessageReactionRemoveAll, async (message) => {
    await runWithTrace(discordMessageTraceContext(message), async () => {
      await persistReactionMessage(input, message).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction clear");
      });
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "ai") return;
    await interaction
      .reply({
        content: "Discord AI Agent slash commands are disabled. Mention me with `@ai status` or `@ai tools` instead.",
        flags: MessageFlags.Ephemeral
      })
      .catch((error) => {
        logger.warn({ err: error }, "Failed to reply to stale slash command interaction");
      });
  });

  return {
    client,
    login: async () => {
      if (!input.config.discord.token) throw new Error("DISCORD_TOKEN is required.");
      await client.login(input.config.discord.token);
    },
    drain: async (timeoutMs = 30_000) => {
      acceptingMessages = false;
      if (activeMessageHandlers.size === 0) return;
      logger.info({ activeMessageHandlers: activeMessageHandlers.size, timeoutMs }, "Waiting for active Discord message handlers to drain");
      await waitForActiveHandlers(activeMessageHandlers, timeoutMs);
    },
    destroy: () => {
      acceptingMessages = false;
      client.destroy();
    }
  };
}

async function waitForActiveHandlers(activeHandlers: Set<Promise<void>>, timeoutMs: number) {
  if (activeHandlers.size === 0) return;
  await Promise.race([
    Promise.allSettled([...activeHandlers]),
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    })
  ]);
}

// Compatibility re-exports: prefer importing from the focused modules directly.
export {
  deletedMessageIdsForConfiguredGuild,
  discordChannelThreadKey,
  explicitChannelMentionIds,
  explicitRoleMentionIds,
  explicitUserMentionIds,
  hasExplicitBotAddress,
  hasExplicitBotMention,
  isSelfMessage,
  resolveBotMentionContext,
  shouldProcessGuildEvent,
  stripBotAddress
} from "./mentionParsing.js";
export {
  REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT,
  SESSION_CONTEXT_MESSAGE_LIMIT,
  sessionContextMessageLimitForReplyContext
} from "./turnPreparation.js";
export { runQueuedAgentRuntimeExecution } from "./agentDelivery.js";
export { handleUndoCrossReaction, persistReactionMessage } from "./reactions.js";
