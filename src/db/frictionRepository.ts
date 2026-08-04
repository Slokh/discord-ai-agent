import { randomUUID } from "node:crypto";
import { Entry, Frog, Store } from "frog";
import type { DbPool } from "./pool.js";

const FROG_NAMESPACE = "discord-ai-agent";

export type AgentFrictionCategory =
  | "tool_contract"
  | "tool_result"
  | "missing_capability"
  | "instruction_conflict"
  | "data_quality"
  | "delivery"
  | "other";

export type AgentFrictionRecord = {
  id: string;
  title: string;
  body: string;
  severity: "blocker" | "major" | "minor";
  category: AgentFrictionCategory;
  affectedCapability: string | null;
  occurrences: number;
  appRevision: string | null;
  executionId: string | null;
  sessionId: string | null;
};

export async function recordAgentFriction(pool: DbPool, input: {
  title: string;
  body: string;
  severity: AgentFrictionRecord["severity"];
  category: AgentFrictionCategory;
  affectedCapability?: string | null;
  appRevision?: string | null;
  executionId?: string | null;
  sessionId?: string | null;
}) {
  const result = await frictionLog(pool).log({
    title: bounded(input.title, 200),
    body: bounded(input.body, 4_000),
    severity: input.severity,
    context: {
      source: "normal-reply-agent",
      category: input.category,
      ...(input.affectedCapability ? { affectedCapability: bounded(input.affectedCapability, 100) } : {}),
      ...(input.appRevision ? { appRevision: bounded(input.appRevision, 100) } : {}),
      ...(input.executionId ? { executionId: bounded(input.executionId, 200) } : {}),
      ...(input.sessionId ? { sessionId: bounded(input.sessionId, 200) } : {}),
    },
  });
  return { id: result.entry.id, created: result.created, occurrences: result.occurrences };
}

export async function listAgentFriction(pool: DbPool, input: { limit?: number } = {}): Promise<AgentFrictionRecord[]> {
  const requestedLimit = input.limit !== undefined && Number.isFinite(input.limit) ? Math.trunc(input.limit) : 20;
  const limit = Math.max(1, Math.min(100, requestedLimit));
  const records = await frictionLog(pool).logs();
  return records.slice(-limit).reverse().map(({ entry, occurrences }) => {
    const context = entry.context ?? {};
    return {
      id: entry.id,
      title: entry.title,
      body: entry.body,
      severity: entry.severity,
      category: category(context.category),
      affectedCapability: optionalString(context.affectedCapability),
      occurrences,
      appRevision: optionalString(context.appRevision),
      executionId: optionalString(context.executionId),
      sessionId: optionalString(context.sessionId),
    };
  });
}

export async function resolveAgentFriction(pool: DbPool, id: string) {
  return frictionLog(pool).store.remove(id);
}

export async function clearAgentFrictionForUser(pool: DbPool, userId: string) {
  const runtime = await pool.query(
    `SELECT session.session_id, execution.execution_id
     FROM agent_runtime_sessions session
     LEFT JOIN agent_runtime_executions execution ON execution.session_id = session.session_id
     WHERE session.user_id = $1 OR session.requested_by = $1`,
    [userId],
  );
  const sessionIds = new Set(runtime.rows.map((row) => optionalString(row.session_id)).filter(isString));
  const executionIds = new Set(runtime.rows.map((row) => optionalString(row.execution_id)).filter(isString));
  const log = frictionLog(pool);
  const records = await log.logs();
  const matchingIds = records.flatMap(({ entry }) => {
    const context = entry.context ?? {};
    return sessionIds.has(optionalString(context.sessionId) ?? "")
      || executionIds.has(optionalString(context.executionId) ?? "")
      ? [entry.id]
      : [];
  });
  await Promise.all(matchingIds.map((id) => log.store.remove(id)));
  return matchingIds.length;
}

function frictionLog(pool: DbPool) {
  return Frog.create({
    store: postgresStore(pool),
  });
}

/**
 * Binds Frog's released store contract to the app-owned pool. The CLI uses
 * Frog's connection-string store; the running app must reuse its managed pool.
 */
function postgresStore(pool: DbPool) {
  const records = async () => {
    const result = await pool.query(
      `SELECT id, contents, occurrence_count
       FROM frog_entries
       WHERE namespace = $1
       ORDER BY id`,
      [FROG_NAMESPACE],
    );
    return result.rows.map((row) => ({
      entry: Entry.parse(row.contents, { id: row.id }),
      occurrences: Number(row.occurrence_count),
    }));
  };

  return Store.from({
    name: "postgres",
    tracksOccurrences: true,
    records,
    read: async () => (await records()).map(({ entry }) => entry),
    get: async (id) => {
      const result = await pool.query(
        "SELECT id, contents FROM frog_entries WHERE namespace = $1 AND id = $2",
        [FROG_NAMESPACE, id],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Friction entry \`${id}\` does not exist.`);
      return Entry.parse(row.contents, { id: row.id });
    },
    write: async (entry, options = {}) => {
      const id = options.id ?? newEntryId(entry.title);
      const entryKey = `entry:${id}`;
      const titleKey = `title:${Entry.normalizeTitle(entry.title)}`;
      await pool.query(
        `INSERT INTO frog_entries AS existing(namespace, id, dedupe_key, contents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(namespace, id) DO UPDATE SET
           dedupe_key = CASE
             WHEN existing.dedupe_key LIKE 'title:%' AND NOT EXISTS (
               SELECT 1 FROM frog_entries AS duplicate
               WHERE duplicate.namespace = $1 AND duplicate.dedupe_key = $5 AND duplicate.id <> $2
             ) THEN $5
             WHEN existing.dedupe_key LIKE 'title:%' THEN $3
             ELSE existing.dedupe_key
           END,
           contents = EXCLUDED.contents,
           updated_at = now()`,
        [FROG_NAMESPACE, id, entryKey, Entry.serialize(entry), titleKey],
      );
      return { id, location: postgresLocation(id) };
    },
    remove: async (id) => {
      const result = await pool.query(
        "DELETE FROM frog_entries WHERE namespace = $1 AND id = $2 RETURNING id",
        [FROG_NAMESPACE, id],
      );
      return (result.rowCount ?? 0) > 0;
    },
    location: postgresLocation,
    log: async (entry, options = {}) => {
      const id = newEntryId(entry.title);
      const dedupeKey = options.force
        ? `forced:${id}`
        : `title:${Entry.normalizeTitle(entry.title)}`;
      const result = await pool.query(
        `INSERT INTO frog_entries AS existing(namespace, id, dedupe_key, contents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(namespace, dedupe_key) DO UPDATE SET
           occurrence_count = existing.occurrence_count + 1,
           updated_at = now()
         RETURNING id, contents, occurrence_count, (occurrence_count = 1) AS created`,
        [FROG_NAMESPACE, id, dedupeKey, Entry.serialize(entry)],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Postgres did not return the logged friction entry.");
      return {
        created: row.created === true,
        entry: Entry.parse(row.contents, { id: row.id }),
        location: postgresLocation(row.id),
        occurrences: Number(row.occurrence_count),
      };
    },
  });
}

function newEntryId(title: string) {
  return `${Entry.newId({ title })}-${randomUUID().slice(0, 8)}`;
}

function postgresLocation(id: string) {
  return `postgres:${encodeURIComponent(FROG_NAMESPACE)}/${encodeURIComponent(id)}`;
}

function bounded(value: string, limit: number) {
  const normalized = value.trim();
  if (!normalized) throw new Error("Friction title and body must not be empty.");
  return normalized.slice(0, limit);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function isString(value: string | null): value is string {
  return value !== null;
}

function category(value: unknown): AgentFrictionCategory {
  const categories: AgentFrictionCategory[] = [
    "tool_contract", "tool_result", "missing_capability", "instruction_conflict", "data_quality", "delivery", "other",
  ];
  return typeof value === "string" && categories.includes(value as AgentFrictionCategory)
    ? value as AgentFrictionCategory
    : "other";
}
