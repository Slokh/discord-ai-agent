import {
  ChannelType,
  Events,
  type Client,
  type Collection,
  type Guild,
  type GuildBasedChannel,
  type Message,
  PermissionsBitField
} from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { embeddingPriorityForMessageTimestamp, type MessageEmbeddingEnqueueOptions } from "../jobs/queue.js";
import { channelRecordFromChannel, persistDiscordMessage } from "./messagePersistence.js";
import { logger } from "../util/logger.js";

type CrawlableChannel = GuildBasedChannel & {
  messages?: {
    fetch: (options: { limit: number; before?: string; after?: string }) => Promise<Collection<string, Message>>;
  };
  threads?: {
    fetchActive?: () => Promise<{ threads: Collection<string, any> }>;
    fetchArchived?: (options?: Record<string, unknown>) => Promise<{ threads: Collection<string, any>; hasMore?: boolean }>;
  };
};

type EmbeddingQueue = {
  enqueueMessageEmbedding: (messageId: string, options?: MessageEmbeddingEnqueueOptions) => Promise<string | null>;
};

type CrawlEmbeddingQueueStatus = "queued" | "deduped" | "empty" | "bot" | "privacy_deleted" | "unavailable" | "error";

export class DiscordCrawler {
  private embeddingQueue?: EmbeddingQueue;
  private warnedMissingEmbeddingQueue = false;
  private activeCrawlRunId?: string;

  constructor(
    private readonly input: {
      client: Client;
      repo: DiscordAiAgentRepository;
      config: AppConfig;
      embeddingQueue?: EmbeddingQueue;
    }
  ) {
    this.embeddingQueue = input.embeddingQueue;
  }

  setEmbeddingQueue(embeddingQueue: EmbeddingQueue) {
    this.embeddingQueue = embeddingQueue;
  }

  async crawlConfiguredGuild() {
    await waitForDiscordClientReady(this.input.client);

    const guildId = this.input.config.discord.guildId;
    if (!guildId) throw new Error("Discord guild ID is required to crawl.");

    const guild = await this.input.client.guilds.fetch(guildId);
    await guild.channels.fetch();
    await this.input.repo.upsertGuild({
      id: guild.id,
      name: guild.name,
      raw: { id: guild.id, name: guild.name }
    });

    const channels = await this.discoverCrawlableChannels(guild);
    const runId = `crawl-${guild.id}-${Date.now()}`;
    this.activeCrawlRunId = runId;
    const crawlStartedAt = Date.now();
    await this.input.repo.upsertProcessRun({
      runId,
      traceId: runId,
      kind: "crawl",
      status: "running",
      title: `Discord crawl: ${guild.name}`,
      summary: `Discovered ${channels.length} crawlable channels and threads.`,
      guildId: guild.id,
      requester: "system",
      source: "discord_crawler",
      metadata: { channelCount: channels.length }
    });
    await Promise.all(channels.map((channel) => this.input.repo.ensureCrawlCursor({ guildId: guild.id, channelId: channel.id })));
    logger.info({ channelCount: channels.length }, "Starting full Discord crawl");

    try {
      for (const channel of channels) {
        const channelStartedAt = Date.now();
        await this.input.repo.recordProcessRunSpan({
          runId,
          spanId: `channel-${channel.id}`,
          name: channel.name ? `#${channel.name}` : channel.id,
          status: "running",
          startedAt: new Date(channelStartedAt),
          metadata: { channelId: channel.id, channelType: channel.type, isThread: "isThread" in channel ? Boolean(channel.isThread()) : false }
        });
        await this.crawlChannel(channel)
          .then(async () => {
            await this.input.repo.recordProcessRunSpan({
              runId,
              spanId: `channel-${channel.id}`,
              name: channel.name ? `#${channel.name}` : channel.id,
              status: "succeeded",
              startedAt: new Date(channelStartedAt),
              completedAt: new Date(),
              durationMs: Date.now() - channelStartedAt,
              metadata: { channelId: channel.id }
            });
          })
          .catch(async (error) => {
            logger.error({ err: error, channelId: channel.id }, "Channel crawl failed");
            await this.input.repo.recordProcessRunSpan({
              runId,
              spanId: `channel-${channel.id}`,
              name: channel.name ? `#${channel.name}` : channel.id,
              status: "failed",
              startedAt: new Date(channelStartedAt),
              completedAt: new Date(),
              durationMs: Date.now() - channelStartedAt,
              metadata: { channelId: channel.id, error: error instanceof Error ? error.message : String(error) }
            });
            await this.input.repo.updateCrawlCursor({
              guildId: guild.id,
              channelId: channel.id,
              status: "error",
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
      const crawlStatus = await this.input.repo.getCrawlStatus(guild.id);
      await this.input.repo.storeProcessRunArtifact({
        runId,
        kind: "crawl_summary",
        name: "Crawl summary",
        content: JSON.stringify({ guildId: guild.id, channelCount: channels.length, crawlStatus }, null, 2),
        contentType: "application/json",
        metadata: { channelCount: channels.length }
      });
      await this.input.repo.updateProcessRun({
        runId,
        status: crawlStatus.some((row) => row.status === "error") ? "failed" : "succeeded",
        summary: `Crawl finished in ${formatDurationSeconds(Date.now() - crawlStartedAt)}.`,
        metadata: { crawlStatus, durationMs: Date.now() - crawlStartedAt }
      });
    } finally {
      this.activeCrawlRunId = undefined;
    }
  }

  async discoverCrawlableChannels(guild: Guild): Promise<CrawlableChannel[]> {
    const botMember = await guild.members.fetchMe();
    const channels: CrawlableChannel[] = [];
    const seenChannelIds = new Set<string>();

    for (const channel of guild.channels.cache.values()) {
      if (!channel) continue;
      await this.persistChannel(guild.id, channel);

      if (await this.isChannelExcluded(channel.id)) continue;
      if (!this.canBotCrawl(botMember, channel)) continue;
      if (hasMessageFetch(channel)) pushUniqueCrawlChannel(channels, seenChannelIds, channel);

      for (const thread of await this.fetchThreads(channel as CrawlableChannel)) {
        await this.persistThread(guild.id, thread);
        if (await this.isChannelExcluded(thread.id)) continue;
        if (this.canBotCrawl(botMember, thread) && hasMessageFetch(thread)) {
          pushUniqueCrawlChannel(channels, seenChannelIds, thread);
        }
      }
    }

    return channels;
  }

  async crawlChannel(channel: CrawlableChannel) {
    if (!channel.guildId || !hasMessageFetch(channel)) return;
    if (await this.isChannelExcluded(channel.id)) {
      logger.debug({ channelId: channel.id }, "Skipping crawl for excluded channel");
      return;
    }
    const existing = await this.input.repo.getCrawlCursor(channel.id);
    if (existing?.status === "complete" && existing.last_message_id) {
      await this.backfillChannel(channel, existing.last_message_id);
      return;
    }
    const start = resolveCrawlStart(existing);
    if (start.skip) {
      logger.debug({ channelId: channel.id }, "Skipping completed channel crawl");
      return;
    }
    let before = start.beforeMessageId;
    let newestCrawlMessageId = existing?.last_message_id ?? undefined;
    let total = 0;

    await this.input.repo.updateCrawlCursor({
      guildId: channel.guildId,
      channelId: channel.id,
      beforeMessageId: before,
      status: "running"
    });

    while (true) {
      const messagesApi = channel.messages;
      if (!messagesApi) break;
      const page = await withDiscordFetchRetry(
        () =>
          messagesApi.fetch({
            limit: this.input.config.crawlBatchSize,
            before
          }),
        retryOptionsFromConfig(this.input.config)
      );
      if (page.size === 0) break;

      const messages = sortMessagesNewestFirst([...page.values()]);
      const pageBounds = selectCrawlPageBounds(messages);
      const embeddingQueueStats = emptyEmbeddingQueueStats();
      for (const message of messages) {
        if (this.isSelfMessage(message)) continue;
        await persistDiscordMessage(this.input.repo, message);
        embeddingQueueStats[await this.queueEmbeddingForMessage(message)] += 1;
      }

      total += messages.length;
      before = pageBounds.oldestMessageId;
      newestCrawlMessageId = preserveNewestCrawlMessageId(newestCrawlMessageId, pageBounds.newestMessageId);
      await this.input.repo.updateCrawlCursor({
        guildId: channel.guildId,
        channelId: channel.id,
        beforeMessageId: before,
        lastMessageId: newestCrawlMessageId,
        status: "running",
        crawledCountIncrement: messages.length
      });
      await this.recordCrawlPageEvent(channel.id, messages.length, embeddingQueueStats);
      logger.debug({ channelId: channel.id, pageSize: messages.length, embeddingQueueStats }, "Crawl page stored");

      if (page.size < this.input.config.crawlBatchSize || !before) break;
    }

    await this.input.repo.updateCrawlCursor({
      guildId: channel.guildId,
      channelId: channel.id,
      beforeMessageId: before,
      status: "complete"
    });
    logger.info({ channelId: channel.id, total }, "Channel crawl complete");
  }

  private async backfillChannel(channel: CrawlableChannel, afterMessageId: string) {
    if (!channel.guildId || !hasMessageFetch(channel)) return;
    let after = afterMessageId;
    let total = 0;

    await this.input.repo.updateCrawlCursor({
      guildId: channel.guildId,
      channelId: channel.id,
      lastMessageId: after,
      status: "running"
    });

    while (true) {
      const messagesApi = channel.messages;
      if (!messagesApi) break;
      const page = await withDiscordFetchRetry(
        () =>
          messagesApi.fetch({
            limit: this.input.config.crawlBatchSize,
            after
          }),
        retryOptionsFromConfig(this.input.config)
      );
      if (page.size === 0) break;

      const messages = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const embeddingQueueStats = emptyEmbeddingQueueStats();
      for (const message of messages) {
        if (this.isSelfMessage(message)) continue;
        await persistDiscordMessage(this.input.repo, message);
        embeddingQueueStats[await this.queueEmbeddingForMessage(message)] += 1;
      }

      total += messages.length;
      after = messages[messages.length - 1]?.id ?? after;
      await this.input.repo.updateCrawlCursor({
        guildId: channel.guildId,
        channelId: channel.id,
        lastMessageId: after,
        status: "running",
        crawledCountIncrement: messages.length
      });
      await this.recordCrawlPageEvent(channel.id, messages.length, embeddingQueueStats);
      logger.debug({ channelId: channel.id, pageSize: messages.length, embeddingQueueStats }, "Crawl backfill page stored");

      if (page.size < this.input.config.crawlBatchSize) break;
    }

    await this.input.repo.updateCrawlCursor({
      guildId: channel.guildId,
      channelId: channel.id,
      lastMessageId: after,
      status: "complete"
    });
    logger.info({ channelId: channel.id, total }, "Channel backfill complete");
  }

  private canBotCrawl(member: { permissionsIn: (channel: any) => PermissionsBitField }, channel: GuildBasedChannel) {
    const permissions = member.permissionsIn(channel);
    return (
      permissions.has(PermissionsBitField.Flags.ViewChannel) &&
      permissions.has(PermissionsBitField.Flags.ReadMessageHistory)
    );
  }

  private async fetchThreads(channel: CrawlableChannel): Promise<CrawlableChannel[]> {
    const threads: CrawlableChannel[] = [];
    if (!channel.threads) return threads;

    const active = await withOptionalDiscordFetchRetry(() => channel.threads?.fetchActive?.(), retryOptionsFromConfig(this.input.config));
    if (active?.threads) threads.push(...active.threads.values());

    for (const type of ["public", "private"] as const) {
      let before: Date | undefined;
      while (true) {
        const archived = await withOptionalDiscordFetchRetry(
          () => channel.threads?.fetchArchived?.({ type, limit: 100, before }),
          retryOptionsFromConfig(this.input.config)
        );
        if (!archived?.threads?.size) break;
        const pageThreads = [...archived.threads.values()];
        threads.push(...pageThreads);
        if (!archived.hasMore) break;
        const oldest = pageThreads[pageThreads.length - 1] as { archiveTimestamp?: number; createdTimestamp?: number } | undefined;
        const timestamp = oldest?.archiveTimestamp ?? oldest?.createdTimestamp;
        if (!timestamp) break;
        before = new Date(timestamp);
      }
    }

    return threads;
  }

  private async persistChannel(guildId: string, channel: GuildBasedChannel) {
    await this.input.repo.upsertChannel({ ...channelRecordFromChannel(guildId, channel), isThread: false });
  }

  private async persistThread(guildId: string, thread: CrawlableChannel) {
    await this.input.repo.upsertChannel({ ...channelRecordFromChannel(guildId, thread), isThread: true });
  }

  private async isChannelExcluded(channelId: string) {
    return this.input.repo.isChannelExcluded(channelId);
  }

  private isSelfMessage(message: Message) {
    return Boolean(this.input.client.user?.id && message.author.id === this.input.client.user.id);
  }

  private async queueEmbeddingForMessage(message: Message): Promise<CrawlEmbeddingQueueStatus> {
    if (!message.content?.trim()) return "empty";
    if (message.author.bot) return "bot";
    if (await this.input.repo.isUserPrivacyDeleted(message.author.id)) return "privacy_deleted";

    if (!this.embeddingQueue) {
      if (!this.warnedMissingEmbeddingQueue) {
        this.warnedMissingEmbeddingQueue = true;
        logger.warn("Crawler has no embedding queue; stored messages will remain keyword-searchable until backfill is queued");
      }
      return "unavailable";
    }

    try {
      const jobId = await this.embeddingQueue.enqueueMessageEmbedding(message.id, {
        priority: embeddingPriorityForMessageTimestamp(message.createdTimestamp)
      });
      return jobId ? "queued" : "deduped";
    } catch (error) {
      logger.warn({ err: error, messageId: message.id }, "Failed to enqueue message embedding; message remains searchable by keyword");
      return "error";
    }
  }

  private async recordCrawlPageEvent(channelId: string, pageSize: number, embeddingQueueStats: Record<CrawlEmbeddingQueueStatus, number>) {
    if (!this.activeCrawlRunId) return;
    await this.input.repo
      .recordProcessRunEvent({
        runId: this.activeCrawlRunId,
        eventName: "crawl.page.stored",
        summary: `Stored ${pageSize} messages from ${channelId}`,
        metadata: { channelId, pageSize, embeddingQueueStats }
      })
      .catch((error) => logger.warn({ err: error, channelId }, "Failed to record crawl page event"));
  }
}

function formatDurationSeconds(value: number) {
  return `${(value / 1000).toFixed(3)}s`;
}

function emptyEmbeddingQueueStats(): Record<CrawlEmbeddingQueueStatus, number> {
  return {
    queued: 0,
    deduped: 0,
    empty: 0,
    bot: 0,
    privacy_deleted: 0,
    unavailable: 0,
    error: 0
  };
}

function hasMessageFetch(channel: any): channel is CrawlableChannel {
  return Boolean(channel?.messages?.fetch);
}

function pushUniqueCrawlChannel(channels: CrawlableChannel[], seenChannelIds: Set<string>, channel: CrawlableChannel) {
  if (seenChannelIds.has(channel.id)) return;
  seenChannelIds.add(channel.id);
  channels.push(channel);
}

export async function waitForDiscordClientReady(
  client: Pick<Client, "isReady" | "once" | "off">,
  timeoutMs = 30_000
): Promise<void> {
  if (client.isReady()) return;

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Discord client readiness before crawl."));
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      client.off(Events.ClientReady, onReady);
    };

    client.once(Events.ClientReady, onReady);
  });
}

export function isTextLikeChannelType(type: ChannelType | number) {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
    ChannelType.GuildForum,
    ChannelType.GuildMedia
  ].includes(type as ChannelType);
}

export function resolveCrawlStart(cursor?: { status: string; before_message_id: string | null; last_message_id?: string | null }) {
  if (cursor?.status === "complete" && cursor.last_message_id) {
    return { skip: true, beforeMessageId: undefined };
  }

  return {
    skip: false,
    beforeMessageId: cursor?.before_message_id ?? undefined
  };
}

export function selectCrawlPageBounds(messages: Array<{ id: string; createdTimestamp: number }>) {
  const sorted = sortMessagesNewestFirst(messages);
  return {
    newestMessageId: sorted[0]?.id,
    oldestMessageId: sorted[sorted.length - 1]?.id
  };
}

export function preserveNewestCrawlMessageId(currentNewest: string | null | undefined, pageNewest: string | undefined) {
  return currentNewest ?? pageNewest;
}

type DiscordFetchRetryOptions = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
};

function retryOptionsFromConfig(config: AppConfig): DiscordFetchRetryOptions {
  return {
    retries: config.crawlFetchRetries,
    baseDelayMs: config.crawlRetryBaseMs,
    maxDelayMs: config.crawlRetryMaxMs
  };
}

export async function withDiscordFetchRetry<T>(
  operation: () => Promise<T>,
  options: DiscordFetchRetryOptions
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = discordRetryDelayMs(error, attempt, options);
      if (delayMs == null || attempt >= options.retries) throw error;
      attempt += 1;
      await (options.sleep ?? sleep)(delayMs);
    }
  }
}

async function withOptionalDiscordFetchRetry<T>(
  operation: () => Promise<T> | T | undefined,
  options: DiscordFetchRetryOptions
): Promise<T | undefined> {
  try {
    return await withDiscordFetchRetry(async () => operation(), options);
  } catch (error) {
    logger.warn({ err: error }, "Optional Discord crawl fetch failed");
    return undefined;
  }
}

export function discordRetryDelayMs(error: unknown, attempt: number, options: DiscordFetchRetryOptions) {
  if (!isRetryableDiscordFetchError(error)) return undefined;
  const retryAfterMs = retryAfterMsFromDiscordError(error);
  if (retryAfterMs != null) return clampDelayMs(retryAfterMs, options.maxDelayMs);
  return clampDelayMs(options.baseDelayMs * 2 ** attempt, options.maxDelayMs);
}

export function retryAfterMsFromDiscordError(error: unknown): number | undefined {
  const source = error as any;
  const value =
    source?.retryAfter ??
    source?.retry_after ??
    source?.rawError?.retry_after ??
    source?.data?.retry_after ??
    source?.response?.headers?.get?.("retry-after");
  if (value == null) return undefined;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric < 1000 ? Math.ceil(numeric * 1000) : Math.ceil(numeric);
}

function isRetryableDiscordFetchError(error: unknown) {
  const source = error as any;
  const status = Number(source?.status ?? source?.code ?? source?.response?.status);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"].includes(String(source?.code ?? ""));
}

function clampDelayMs(delayMs: number, maxDelayMs: number) {
  if (maxDelayMs <= 0) return 0;
  return Math.min(Math.max(0, Math.ceil(delayMs)), maxDelayMs);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sortMessagesNewestFirst<T extends { createdTimestamp: number; id: string }>(messages: T[]) {
  return messages.sort((a, b) => b.createdTimestamp - a.createdTimestamp || b.id.localeCompare(a.id));
}
