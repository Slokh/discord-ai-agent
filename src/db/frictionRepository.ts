import { FrictionLog, PostgresStore } from "frog";
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
  const result = await frictionLog(pool).record({
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
  const records = await frictionLog(pool).records();
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
  return frictionLog(pool).remove(id);
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
  const records = await log.records();
  const matchingIds = records.flatMap(({ entry }) => {
    const context = entry.context ?? {};
    return sessionIds.has(optionalString(context.sessionId) ?? "")
      || executionIds.has(optionalString(context.executionId) ?? "")
      ? [entry.id]
      : [];
  });
  await Promise.all(matchingIds.map((id) => log.remove(id)));
  return matchingIds.length;
}

function frictionLog(pool: DbPool) {
  return new FrictionLog({
    store: PostgresStore.adapter({ client: pool, namespace: FROG_NAMESPACE }),
  });
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
