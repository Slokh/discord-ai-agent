import type { DbPool } from "./pool.js";
import * as agentSettings from "./agentSettingsRepository.js";
import * as agentTasks from "./agentTaskRepository.js";
import * as audit from "./auditRepository.js";
import * as conversationMemory from "./conversationMemoryRepository.js";
import * as deploymentAnnouncements from "./deploymentAnnouncementRepository.js";
import * as discordArchive from "./discordArchiveRepository.js";
import * as discordBugMarkers from "./discordBugMarkerRepository.js";
import * as discordBugReports from "./discordBugReportRepository.js";
import * as discordComponentActions from "./discordComponentActionRepository.js";
import * as discordEmojiUsage from "./discordEmojiUsageRepository.js";
import * as embeddings from "./embeddingRepository.js";
import * as friction from "./frictionRepository.js";
import * as processRuns from "./processRunRepository.js";
import * as retrieval from "./retrievalRepository.js";
import * as serverOverlays from "./serverOverlayRepository.js";
import type { AgentRunFeedback, PersistedMessage } from "./types.js";

export type * from "./types.js";
export type { DiscordEmojiCultureProfile, DiscordEmojiUsageExample } from "./discordEmojiUsageRepository.js";
export type { GuildAgentSettings } from "./agentSettingsRepository.js";

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
    ...bindRepository(pool, discordBugMarkers),
    ...bindRepository(pool, discordBugReports),
    ...bindRepository(pool, discordComponentActions),
    ...bindRepository(pool, embeddings),
    ...bindRepository(pool, friction),
    ...bindRepository(pool, processRuns),
    ...bindRepository(pool, retrieval),
    ...bindRepository(pool, serverOverlays),

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
      await friction.clearAgentFrictionForUser(pool, userId);
      await discordArchive.requestUserDeletion(pool, userId);
      await discordEmojiUsage.clearDiscordEmojiUsageForAuthor(pool, userId);
    },
    listDiscordEmojiCultureProfiles: (...args: Tail<Parameters<typeof discordEmojiUsage.listDiscordEmojiCultureProfiles>>) =>
      discordEmojiUsage.listDiscordEmojiCultureProfiles(pool, ...args),
    async getRunFeedback(runId: string): Promise<AgentRunFeedback | undefined> {
      const result = await pool.query("SELECT * FROM agent_run_feedback WHERE run_id = $1", [runId]);
      return result.rows[0] ? rowToRunFeedback(result.rows[0]) : undefined;
    },
    async upsertRunFeedback(input: {
      runId: string;
      rating: "good" | "bad";
      note?: string | null;
      expectedBehavior?: string | null;
      failureMode?: AgentRunFeedback["failureMode"];
      expectedTools?: string[];
      forbiddenTools?: string[];
      mustContain?: string[];
      mustNotContain?: string[];
      captureEval?: boolean;
    }): Promise<AgentRunFeedback> {
      const result = await pool.query(
        `INSERT INTO agent_run_feedback(
           run_id, rating, note, expected_behavior, failure_mode,
           expected_tools, forbidden_tools, must_contain, must_not_contain, capture_eval
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(run_id) DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note,
           expected_behavior = EXCLUDED.expected_behavior, failure_mode = EXCLUDED.failure_mode,
           expected_tools = EXCLUDED.expected_tools, forbidden_tools = EXCLUDED.forbidden_tools,
           must_contain = EXCLUDED.must_contain, must_not_contain = EXCLUDED.must_not_contain,
           capture_eval = EXCLUDED.capture_eval, updated_at = now()
         RETURNING *`,
        [
          input.runId, input.rating, input.note ?? null, input.expectedBehavior ?? null, input.failureMode ?? null,
          input.expectedTools ?? [], input.forbiddenTools ?? [], input.mustContain ?? [], input.mustNotContain ?? [],
          Boolean(input.captureEval),
        ]
      );
      return rowToRunFeedback(result.rows[0]);
    },
    async captureRunFeedbackForEval(input: { runId: string; note: string }): Promise<AgentRunFeedback> {
      const result = await pool.query(
        `INSERT INTO agent_run_feedback(run_id, rating, note, failure_mode, capture_eval)
         VALUES ($1, 'bad', $2, 'other', true)
         ON CONFLICT(run_id) DO UPDATE SET
           rating = 'bad',
           note = coalesce(agent_run_feedback.note, EXCLUDED.note),
           failure_mode = coalesce(agent_run_feedback.failure_mode, EXCLUDED.failure_mode),
           capture_eval = true,
           updated_at = now()
         RETURNING *`,
        [input.runId, input.note],
      );
      return rowToRunFeedback(result.rows[0]);
    }
  };
}

type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
export type DiscordAiAgentRepository = ReturnType<typeof createAppDatabase>;

function rowToRunFeedback(row: any): AgentRunFeedback {
  return {
    runId: String(row.run_id),
    rating: String(row.rating) as AgentRunFeedback["rating"],
    note: row.note == null ? null : String(row.note),
    expectedBehavior: row.expected_behavior == null ? null : String(row.expected_behavior),
    failureMode: row.failure_mode == null ? null : String(row.failure_mode) as AgentRunFeedback["failureMode"],
    expectedTools: stringList(row.expected_tools),
    forbiddenTools: stringList(row.forbidden_tools),
    mustContain: stringList(row.must_contain),
    mustNotContain: stringList(row.must_not_contain),
    captureEval: Boolean(row.capture_eval),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
