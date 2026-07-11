import { z } from "zod";

export const runtimeEventCategories = ["ingress", "context", "model", "tool", "retrieval", "delivery", "task", "system"] as const;
export type RuntimeEventCategory = (typeof runtimeEventCategories)[number];
export const runtimeEventPhases = ["started", "progress", "completed", "failed"] as const;
export type RuntimeEventPhase = (typeof runtimeEventPhases)[number];

const runtimeEnvelope = {
  schemaVersion: z.literal(1),
  category: z.enum(runtimeEventCategories),
  phase: z.enum(runtimeEventPhases),
};

const tokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
}).passthrough();

const modelCallMetadataSchema = z.object({
  ...runtimeEnvelope,
  category: z.literal("model"),
  appRevision: z.string().min(1),
  callId: z.string().min(1),
  purpose: z.string().min(1),
  requestedModel: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
  promptBytes: z.number().int().nonnegative(),
  promptFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  messageBytesByRole: z.record(z.string(), z.number().int().nonnegative()),
  toolCount: z.number().int().nonnegative(),
  toolSchemaBytes: z.number().int().nonnegative(),
  toolSchemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  offeredTools: z.array(z.string()),
  maxTokens: z.number().int().positive(),
  model: z.string().optional(),
  finishReason: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  outputChars: z.number().int().nonnegative().optional(),
  requestedToolCalls: z.array(z.string()).optional(),
  error: z.string().optional(),
}).passthrough();

const genericRuntimeSchemas = runtimeEventCategories
  .filter((category) => category !== "model")
  .map((category) => z.object({ ...runtimeEnvelope, category: z.literal(category) }).passthrough());

export const runtimeEventMetadataSchema = z.discriminatedUnion("category", [
  modelCallMetadataSchema,
  ...genericRuntimeSchemas,
] as [typeof modelCallMetadataSchema, ...typeof genericRuntimeSchemas]);

const versionedRuntimeEventSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  "agent.model.call.started": modelCallMetadataSchema,
  "agent.model.call.completed": modelCallMetadataSchema,
  "agent.model.call.failed": modelCallMetadataSchema,
};

export function assertVersionedRuntimeEventMetadata(eventName: string, metadata: Record<string, unknown> | undefined) {
  const schema = versionedRuntimeEventSchemas[eventName];
  if (schema) {
    schema.parse(metadata);
    return;
  }
  runtimeEventMetadataSchema.parse(metadata);
}

export function normalizeRuntimeEventMetadata(input: {
  eventName: string;
  kind?: string | null;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const category = runtimeEventCategory(input.eventName, input.kind);
  const phase = runtimeEventPhase(input.eventName, input.metadata);
  return {
    ...input.metadata,
    // Envelope dimensions are controlled rather than caller-provided labels.
    schemaVersion: 1,
    category,
    phase,
  };
}

export function runtimeEventCategory(eventName: string, kind?: string | null): RuntimeEventCategory {
  if (eventName.startsWith("agent.model") || eventName.includes("synthesis") || kind === "model") return "model";
  if (eventName.startsWith("agent.tool") || kind === "tool") return "tool";
  if (eventName.startsWith("retrieval.") || eventName.startsWith("memory.search")) return "retrieval";
  if (eventName.startsWith("discord.mention") || eventName.startsWith("budget.ingress")) return "ingress";
  if (eventName.startsWith("discord.") || eventName.includes("delivery")) return "delivery";
  if (eventName.startsWith("memory.") || eventName.startsWith("permissions.") || eventName.includes("context")) return "context";
  if (eventName.startsWith("agent.task") || eventName.startsWith("task.") || eventName.startsWith("codegen.") || eventName.startsWith("sandbox.")) return "task";
  return "system";
}

export function runtimeEventPhase(eventName: string, metadata?: Record<string, unknown>): RuntimeEventPhase {
  const explicit = metadata?.phase;
  if (typeof explicit === "string" && runtimeEventPhases.includes(explicit as RuntimeEventPhase)) return explicit as RuntimeEventPhase;
  if (/\.(failed|error|rejected|enqueue_failed)$/.test(eventName)) return "failed";
  if (/\.(complete|completed|handled|ready|resolved|stored|sent|acquired)$/.test(eventName)) return "completed";
  if (/\.(started|received|queued|enqueued)$/.test(eventName)) return "started";
  return "progress";
}
