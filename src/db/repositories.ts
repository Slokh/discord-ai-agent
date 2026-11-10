import type { DbPool } from "./pool.js";
import * as agentSettings from "./agentSettingsRepository.js";
import * as agentRuntimeChatReads from "./agentRuntimeChatReadRepository.js";
import * as audit from "./auditRepository.js";
import * as conversationMemory from "./conversationMemoryRepository.js";
import * as deploymentVerifications from "./deploymentVerificationRepository.js";
import * as discordArchive from "./discordArchiveRepository.js";
import * as discordEmojiUsage from "./discordEmojiUsageRepository.js";
import * as embeddings from "./embeddingRepository.js";
import * as retrieval from "./retrievalRepository.js";
import { clearRetiredFeatureDataForUser } from "./retiredFeatureDataRepository.js";
import * as nanocodeSessions from "./nanocodeSessionRepository.js";
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
    ...bindRepository(pool, agentRuntimeChatReads),
    ...bindRepository(pool, audit),
    ...bindRepository(pool, conversationMemory),
    ...bindRepository(pool, deploymentVerifications),
    ...archive,
    ...bindRepository(pool, embeddings),
    ...bindRepository(pool, retrieval),
    recordNanocodeSession: (input: Parameters<typeof nanocodeSessions.recordNanocodeSession>[1]) =>
      nanocodeSessions.recordNanocodeSession(pool, input),
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
      await clearRetiredFeatureDataForUser(pool, userId);
      await nanocodeSessions.deleteNanocodeSessionsForUser(pool, userId);
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
