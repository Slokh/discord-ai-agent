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
import { clearDiscordBugMarkersForMessage, clearDiscordBugMarkersForReaction, handleDiscordBugMarkerReaction } from "./bugMarkerReaction.js";
import { deletedMessageIdsForConfiguredGuild, isSelfMessage, isSelfUser, shouldProcessGuildEvent } from "./mentionParsing.js";
import { discordMessageTraceContext, recordTraceEvent } from "./requestContext.js";
import { logger } from "../util/logger.js";
import { runWithTrace } from "../util/trace.js";
import { announceDeployment } from "./deploymentAnnouncements.js";
import { handleDiscordRichInteraction } from "./components/interactionHandler.js";
import { DiscordInteractionResponder } from "./components/interactionResponder.js";
import { DiscordTaskSupervisor } from "./taskSupervisor.js";

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
        GatewayIntentBits.GuildExpressions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });
  const taskSupervisor = new DiscordTaskSupervisor(logger);
  let componentActionCleanupTimer: NodeJS.Timeout | null = null;

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
      const obligations = input.deliveryObligations;
      const agentRuntime = input.agentRuntime;
      void taskSupervisor.run({ kind: "maintenance", label: "delivery_startup_sweep", task: () => sweepDiscordDeliveryObligations({
        client: readyClient,
        obligations,
        agentRuntime,
        repo: input.repo,
        logger,
        maxReplyChars: input.config.maxReplyChars,
        premiumSkuIds: input.config.discord.premiumSkuIds
      }) });
    }
    const expireComponentActions = () => void taskSupervisor.run({
      kind: "maintenance",
      label: "component_action_expiry",
      task: async () => {
        const expired = await input.repo.expireDiscordComponentActions({ limit: 2_000 });
        if (expired > 0) logger.info({ expired }, "Expired stale Discord component actions");
      },
    });
    expireComponentActions();
    componentActionCleanupTimer = setInterval(expireComponentActions, 60 * 60_000);
    componentActionCleanupTimer.unref?.();
    void taskSupervisor.run({ kind: "maintenance", label: "deployment_announcement", task: async () => {
      const result = await announceDeployment({
      client: readyClient,
      config: input.config,
      repo: input.repo,
      openRouter: input.openRouter
      });
      if (result !== "disabled" && result !== "duplicate") logger.info({ result, revision: input.config.appRevision }, "Deployment announcement lifecycle completed");
    } });
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

  client.on(Events.MessageCreate, (message) => void taskSupervisor.run({
    kind: "request",
    label: "message_create",
    logContext: { messageId: message.id, channelId: message.channelId },
    task: () => runWithTrace(discordMessageTraceContext(message), () => handleMessageCreate(input, client, message)),
  }));

  client.on(Events.MessageUpdate, (_oldMessage, newMessage) => void taskSupervisor.run({ kind: "maintenance", label: "message_update", task: () =>
    runWithTrace(discordMessageTraceContext(newMessage), async () => {
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
    }),
  }));

  client.on(Events.MessageDelete, (message) => void taskSupervisor.run({ kind: "maintenance", label: "message_delete", task: () =>
    runWithTrace(discordMessageTraceContext(message), async () => {
      if (!shouldProcessGuildEvent(input.config.discord.guildId, message.guildId)) return;
      if (message.id) await input.repo.markMessageDeleted(message.id).catch(() => undefined);
      await recordTraceEvent(input.repo, { eventName: "discord.message.deleted", summary: "Marked Discord message deleted" });
    }),
  }));

  client.on(Events.MessageBulkDelete, (messages) => void taskSupervisor.run({ kind: "maintenance", label: "message_bulk_delete", task: async () => {
    const messageIds = deletedMessageIdsForConfiguredGuild(messages.values(), input.config.discord.guildId);
    await Promise.all(messageIds.map((messageId) => input.repo.markMessageDeleted(messageId).catch(() => undefined)));
  } }));

  client.on(Events.MessageReactionAdd, (reaction, user) => void taskSupervisor.run({ kind: "request", label: "reaction_add", task: () =>
    runWithTrace(discordMessageTraceContext(reaction.message), async () => {
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
        handleDiscordBugMarkerReaction(input, reaction, user, true).catch((error) => {
          logger.warn({ err: error }, "Failed to add Discord bug marker");
        }),
        handleRegenerateReplyReaction(input, client, reaction, user).catch((error) => {
          logger.warn({ err: error }, "Failed to handle regenerate reply reaction");
        })
      ]);
    }),
  }));

  client.on(Events.MessageReactionRemove, (reaction, user) => void taskSupervisor.run({ kind: "maintenance", label: "reaction_remove", task: () =>
    runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      await Promise.all([
        persistReactionMessageUpdate(input, reaction).catch((error) => {
          logger.warn({ err: error }, "Failed to persist reaction remove");
        }),
        handleDiscordBugMarkerReaction(input, reaction, user, false).catch((error) => {
          logger.warn({ err: error }, "Failed to remove Discord bug marker");
        })
      ]);
    }),
  }));

  client.on(Events.MessageReactionRemoveEmoji, (reaction) => void taskSupervisor.run({ kind: "maintenance", label: "reaction_remove_emoji", task: () =>
    runWithTrace(discordMessageTraceContext(reaction.message), async () => {
      await persistReactionMessageUpdate(input, reaction).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction emoji removal");
      });
      await clearDiscordBugMarkersForReaction(input, reaction);
    }),
  }));

  client.on(Events.MessageReactionRemoveAll, (message) => void taskSupervisor.run({ kind: "maintenance", label: "reaction_remove_all", task: () =>
    runWithTrace(discordMessageTraceContext(message), async () => {
      await persistReactionMessage(input, message).catch((error) => {
        logger.warn({ err: error }, "Failed to persist reaction clear");
      });
      await clearDiscordBugMarkersForMessage(input, message);
    }),
  }));

  client.on(Events.InteractionCreate, (interaction) => void taskSupervisor.run({
    kind: "request",
    label: "interaction_create",
    logContext: { interactionId: interaction.id },
    onRejected: async () => {
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        await new DiscordInteractionResponder(interaction, logger).ephemeral("I’m restarting right now. Please try that control again in a moment.");
      }
    },
    task: async () => {
      if (await handleDiscordRichInteraction(input, client, interaction).catch((error) => {
        logger.error({ err: error, interactionId: interaction.id }, "Discord rich interaction handler failed");
        return false;
      })) return;
      if (!interaction.isChatInputCommand() || interaction.commandName !== "ai") return;
      await interaction
        .reply({
          content: "Discord AI Agent slash commands are disabled. Mention me with `@ai status` or `@ai tools` instead.",
          flags: MessageFlags.Ephemeral
        })
        .catch((error) => {
          logger.warn({ err: error }, "Failed to reply to stale slash command interaction");
        });
    },
  }));

  return {
    client,
    login: async () => {
      if (!input.config.discord.token) throw new Error("DISCORD_TOKEN is required.");
      await client.login(input.config.discord.token);
    },
    drain: async (timeoutMs = 30_000) => {
      if (componentActionCleanupTimer) clearInterval(componentActionCleanupTimer);
      await taskSupervisor.drain(timeoutMs);
    },
    destroy: () => {
      taskSupervisor.stopAccepting();
      if (componentActionCleanupTimer) clearInterval(componentActionCleanupTimer);
      client.destroy();
    }
  };
}
