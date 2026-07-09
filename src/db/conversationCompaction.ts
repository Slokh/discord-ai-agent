import type { DbPool } from "./pool.js";
import type { ConversationMessage } from "./repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { logger } from "../util/logger.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 15 * 60 * 1000;

export type ConversationCompactionConfig = {
  threshold: number;
  keepRecent: number;
  utilityModel: string;
};

export function buildConversationSummaryPrompt(messages: Pick<ConversationMessage, "role" | "authorDisplayName" | "content" | "createdAt">[]): string {
  return [
    "Summarize these older Discord agent conversation turns for future context.",
    "Keep durable user preferences, decisions, facts, task outcomes, and unresolved threads. Omit chatter and exact wording unless important.",
    "Return a concise bullet summary under 1200 words.",
    "",
    ...messages.map((message) => {
      const author = message.authorDisplayName ? ` ${message.authorDisplayName}` : "";
      return `[${message.createdAt.toISOString()}] ${message.role}${author}: ${message.content}`;
    })
  ].join("\n");
}

export async function runConversationCompactionOnce(input: {
  db: DbPool;
  openRouter: Pick<OpenRouterClient, "chat">;
  config: ConversationCompactionConfig;
  limit?: number;
}): Promise<{ compactedThreads: number; rawMessagesDeleted: number; snapshotsWritten: number }> {
  if (input.config.threshold <= 0) return { compactedThreads: 0, rawMessagesDeleted: 0, snapshotsWritten: 0 };
  const keepRecent = Math.min(input.config.keepRecent, Math.max(1, input.config.threshold - 1));
  const limit = Math.max(1, Math.min(25, Math.trunc(input.limit ?? 5)));
  const candidates = await input.db.query<{ thread_key: string }>(
    `
      SELECT thread_key
      FROM conversation_messages
      GROUP BY thread_key
      HAVING count(*) > $1
      ORDER BY max(created_at) ASC
      LIMIT $2
    `,
    [input.config.threshold, limit]
  );
  let compactedThreads = 0;
  let rawMessagesDeleted = 0;
  let snapshotsWritten = 0;
  for (const row of candidates.rows) {
    const result = await compactThread(input.db, input.openRouter, input.config.utilityModel, row.thread_key, keepRecent).catch((error) => {
      logger.warn({ err: error, threadKey: row.thread_key }, "Conversation compaction failed; raws kept for retry");
      return null;
    });
    if (!result) continue;
    compactedThreads += 1;
    rawMessagesDeleted += result.deleted;
    snapshotsWritten += 1;
  }
  return { compactedThreads, rawMessagesDeleted, snapshotsWritten };
}

export function startConversationCompactionMaintenance(input: {
  db: DbPool;
  openRouter: Pick<OpenRouterClient, "chat">;
  config: ConversationCompactionConfig;
  intervalMs?: number;
  initialDelayMs?: number;
}): { stop: () => void } | null {
  if (input.config.threshold <= 0) return null;
  const intervalMs = positiveMs(input.intervalMs, DEFAULT_INTERVAL_MS);
  const initialDelayMs = positiveMs(input.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      const result = await runConversationCompactionOnce(input);
      const log = result.snapshotsWritten > 0 ? logger.info.bind(logger) : logger.debug.bind(logger);
      log(result, "Conversation memory compaction sweep complete");
    } catch (error) {
      logger.warn({ err: error }, "Conversation memory compaction sweep failed");
    } finally {
      if (!stopped) timeout = setTimeout(run, intervalMs);
    }
  };
  timeout = setTimeout(run, initialDelayMs);
  return { stop: () => { stopped = true; if (timeout) clearTimeout(timeout); } };
}

async function compactThread(
  db: DbPool,
  openRouter: Pick<OpenRouterClient, "chat">,
  utilityModel: string,
  threadKey: string,
  keepRecent: number
): Promise<{ deleted: number }> {
  const rows = await db.query(
    `
      WITH ordered AS (
        SELECT *, row_number() OVER (ORDER BY created_at DESC, id DESC) AS recent_rank
        FROM conversation_messages
        WHERE thread_key = $1
      )
      SELECT id, thread_key, discord_message_id, role, author_id, author_display_name, content, parts, metadata, created_at
      FROM ordered
      WHERE recent_rank > $2
      ORDER BY created_at ASC, id ASC
    `,
    [threadKey, keepRecent]
  );
  const messages = rows.rows.map(rowToConversationMessage);
  if (messages.length === 0) return { deleted: 0 };
  const response = await openRouter.chat({
    model: utilityModel,
    temperature: 0.1,
    maxTokens: 1600,
    retryPolicy: "cheap",
    messages: [
      { role: "system", content: "You compact Discord assistant memory. Produce faithful, concise summaries only from provided turns." },
      { role: "user", content: buildConversationSummaryPrompt(messages) }
    ]
  });
  const summary = response.content.trim();
  if (!summary) throw new Error("Compaction model returned an empty summary");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const ids = messages.map((message) => message.id);
    await client.query(
      `INSERT INTO conversation_snapshots(thread_key, summary, message_count, from_message_id, to_message_id) VALUES ($1, $2, $3, $4, $5)`,
      [threadKey, summary, messages.length, ids[0], ids[ids.length - 1]]
    );
    const deleted = await client.query("DELETE FROM conversation_messages WHERE thread_key = $1 AND id = ANY($2::bigint[])", [threadKey, ids]);
    await client.query("COMMIT");
    return { deleted: deleted.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function rowToConversationMessage(row: any): ConversationMessage {
  return {
    id: Number(row.id),
    threadKey: String(row.thread_key),
    discordMessageId: row.discord_message_id == null ? null : String(row.discord_message_id),
    role: row.role,
    authorId: row.author_id == null ? null : String(row.author_id),
    authorDisplayName: row.author_display_name == null ? null : String(row.author_display_name),
    content: String(row.content ?? ""),
    parts: row.parts ?? [],
    metadata: row.metadata ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
  };
}

function positiveMs(value: number | undefined, fallback: number) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.trunc(value));
}
