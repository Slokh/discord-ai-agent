import type { DbPool } from "./pool.js";
import * as agentSettings from "./agentSettingsRepository.js";
import * as agentTasks from "./agentTaskRepository.js";
import * as audit from "./auditRepository.js";
import * as conversationMemory from "./conversationMemoryRepository.js";
import * as deploymentAnnouncements from "./deploymentAnnouncementRepository.js";
import * as discordArchive from "./discordArchiveRepository.js";
import * as discordComponentActions from "./discordComponentActionRepository.js";
import * as discordEmojiUsage from "./discordEmojiUsageRepository.js";
import * as discordRetryReactions from "./discordRetryReactionRepository.js";
import * as embeddings from "./embeddingRepository.js";
import * as improvements from "./improvementRepository.js";
import * as improvementReporterConversations from "./improvementReporterConversationRepository.js";
import * as improvementWork from "./improvementWorkRepository.js";
import * as improvementVerifications from "./improvementVerificationRepository.js";
import * as retrieval from "./retrievalRepository.js";
import * as serverOverlays from "./serverOverlayRepository.js";
import * as userPreferences from "./userPreferenceRepository.js";
import type { PersistedMessage } from "./types.js";

export type * from "./types.js";
export type { DiscordEmojiCultureProfile, DiscordEmojiUsageExample } from "./discordEmojiUsageRepository.js";
export type { GuildAgentSettings } from "./agentSettingsRepository.js";
export type { UserPreference } from "./userPreferenceRepository.js";

type PoolFunction = (pool: DbPool, ...args: any[]) => any;
type BoundRepository<T extends Record<string, unknown>> = {
  [K in keyof T as T[K] extends PoolFunction ? K : never]:
    T[K] extends (pool: DbPool, ...args: infer Args) => infer Result ? (...args: Args) => Result : never;
};

function bindRepository<T extends Record<string, unknown>>(pool: DbPool, repository: T): BoundRepository<T> {
  return Object.fromEntries(
    Object.entries(repository)
      .filter(([, value]) => typeof value === "function")
      .map(([name, operation]) => [name, (...args: unknown[]) => (operation as PoolFunction)(pool, ...args)])
  ) as BoundRepository<T>;
}

/** Compose focused SQL modules into the database interface used by the app. */
export function createAppDatabase(pool: DbPool) {
  const archive = bindRepository(pool, discordArchive);
  return {
    ...bindRepository(pool, agentSettings),
    ...bindRepository(pool, agentTasks),
    ...bindRepository(pool, audit),
    ...bindRepository(pool, conversationMemory),
    ...bindRepository(pool, deploymentAnnouncements),
    ...archive,
    ...bindRepository(pool, discordComponentActions),
    ...bindRepository(pool, discordRetryReactions),
    ...bindRepository(pool, embeddings),
    ...bindRepository(pool, improvements),
    ...bindRepository(pool, improvementReporterConversations),
    ...bindRepository(pool, improvementWork),
    ...bindRepository(pool, improvementVerifications),
    ...bindRepository(pool, retrieval),
    ...bindRepository(pool, serverOverlays),
    ...bindRepository(pool, userPreferences),

    async upsertMessage(input: PersistedMessage) {
      const stored = await discordArchive.upsertMessage(pool, input);
      const usage = discordEmojiUsage.emojiUsageEntriesFromMessage(input);
      if (stored.messageExisted || usage.length > 0) await discordEmojiUsage.replaceDiscordEmojiUsageForMessage(pool, input);
      return stored;
    },
    async markMessageDeleted(messageId: string) {
      await discordArchive.markMessageDeleted(pool, messageId);
      await discordEmojiUsage.clearDiscordEmojiUsageForMessage(pool, messageId);
    },
    async requestUserDeletion(userId: string) {
      await improvements.clearImprovementDataForUser(pool, userId);
      await userPreferences.clearUserPreferences(pool, userId);
      await discordArchive.requestUserDeletion(pool, userId);
      await discordEmojiUsage.clearDiscordEmojiUsageForAuthor(pool, userId);
    },
    listDiscordEmojiCultureProfiles: (...args: Tail<Parameters<typeof discordEmojiUsage.listDiscordEmojiCultureProfiles>>) =>
      discordEmojiUsage.listDiscordEmojiCultureProfiles(pool, ...args),
  };
}

type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
export type DiscordAiAgentRepository = ReturnType<typeof createAppDatabase>;
