import { z } from "zod";

const tokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
}).passthrough();

const modelCallMetadataSchema = z.object({
  schemaVersion: z.literal(1),
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

const versionedRuntimeEventSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  "agent.model.call.started": modelCallMetadataSchema,
  "agent.model.call.completed": modelCallMetadataSchema,
  "agent.model.call.failed": modelCallMetadataSchema,
};

export function assertVersionedRuntimeEventMetadata(eventName: string, metadata: Record<string, unknown> | undefined) {
  const schema = versionedRuntimeEventSchemas[eventName];
  if (!schema || metadata?.schemaVersion == null) return;
  schema.parse(metadata);
}
