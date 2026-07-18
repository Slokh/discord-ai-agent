import { createHash } from "node:crypto";
import { z } from "zod";
import type { DiscordResponseFooter } from "./responseSink.js";
import { discordPresentationSchema, type DiscordPresentation } from "./components/validation.js";
import type { AgentFile } from "../tools/types.js";
import { validateDiscordAttachmentNames } from "./components/renderer.js";

export const DISCORD_DELIVERY_INTENT_ARTIFACT_KIND = "discord_delivery_intent";
export const DISCORD_DELIVERY_FILE_ARTIFACT_KIND = "discord_delivery_file";
export const MAX_DURABLE_DELIVERY_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DURABLE_DELIVERY_TOTAL_BYTES = 50 * 1024 * 1024;

const commonFields = {
  deliveryKey: z.string().min(1).max(200),
  requesterUserId: z.string().min(1).max(100),
  content: z.string(),
  storedContent: z.string(),
  responseRedacted: z.boolean(),
  footer: z.object({
    traceUrl: z.string().url().nullable().optional(),
    durationMs: z.number().nonnegative().nullable().optional(),
    extraLines: z.array(z.string()).optional(),
  }).nullable(),
  presentation: discordPresentationSchema.nullable(),
  sourceMessageReaction: z.string().nullable(),
};

const legacyIntentSchema = z.object({
  schemaVersion: z.literal(1),
  ...commonFields,
  files: z.array(z.object({
    name: z.string().min(1),
    contentType: z.string().optional(),
    dataBase64: z.string(),
  })).max(10),
});

export const discordDeliveryFileReferenceSchema = z.object({
  artifactId: z.string().min(1).max(200),
  name: z.string().min(1).max(255),
  contentType: z.string().max(200).optional(),
  sizeBytes: z.number().int().nonnegative().max(MAX_DURABLE_DELIVERY_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const currentIntentSchema = z.object({
  schemaVersion: z.literal(2),
  ...commonFields,
  files: z.array(discordDeliveryFileReferenceSchema).max(10),
});

const discordDeliveryIntentSchema = z.discriminatedUnion("schemaVersion", [legacyIntentSchema, currentIntentSchema]);

export type DiscordDeliveryFileReference = z.infer<typeof discordDeliveryFileReferenceSchema>;
export type DiscordDeliveryIntent = z.infer<typeof discordDeliveryIntentSchema>;

export function createDiscordDeliveryIntent(input: {
  deliveryKey: string;
  requesterUserId: string;
  content: string;
  storedContent?: string;
  footer?: DiscordResponseFooter | null;
  presentation?: DiscordPresentation | null;
  files?: DiscordDeliveryFileReference[];
  sourceMessageReaction?: string | null;
}): DiscordDeliveryIntent {
  validateDiscordAttachmentNames(input.files?.map((file) => file.name) ?? []);
  const totalBytes = (input.files ?? []).reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > MAX_DURABLE_DELIVERY_TOTAL_BYTES) {
    throw new Error(`Discord delivery files exceed the ${MAX_DURABLE_DELIVERY_TOTAL_BYTES}-byte durable recovery limit.`);
  }
  return currentIntentSchema.parse({
    schemaVersion: 2,
    deliveryKey: input.deliveryKey,
    requesterUserId: input.requesterUserId,
    content: input.storedContent ?? input.content,
    storedContent: input.storedContent ?? input.content,
    responseRedacted: input.storedContent !== undefined,
    footer: input.footer ?? null,
    presentation: input.presentation ?? null,
    files: input.files ?? [],
    sourceMessageReaction: input.sourceMessageReaction ?? null,
  });
}

export function serializeDiscordDeliveryIntent(intent: DiscordDeliveryIntent): string {
  return JSON.stringify(intent);
}

export function parseDiscordDeliveryIntent(value: string | unknown): DiscordDeliveryIntent {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return discordDeliveryIntentSchema.parse(parsed);
}

export async function discordDeliveryIntentFiles(
  intent: DiscordDeliveryIntent,
  loadBinary?: (artifactId: string) => Promise<Buffer | undefined>,
): Promise<AgentFile[]> {
  if (intent.schemaVersion === 1) {
    return intent.files.map((file) => ({
      name: file.name,
      data: Buffer.from(file.dataBase64, "base64"),
      ...(file.contentType ? { contentType: file.contentType } : {}),
    }));
  }
  if (intent.files.length > 0 && !loadBinary) throw new Error("Discord delivery intent needs a binary artifact loader.");
  return Promise.all(intent.files.map(async (file) => {
    const data = await loadBinary!(file.artifactId);
    if (!data) throw new Error(`Discord delivery file artifact ${file.artifactId} is unavailable.`);
    if (data.length !== file.sizeBytes) throw new Error(`Discord delivery file artifact ${file.artifactId} has an unexpected size.`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== file.sha256) throw new Error(`Discord delivery file artifact ${file.artifactId} failed checksum validation.`);
    return { name: file.name, data, ...(file.contentType ? { contentType: file.contentType } : {}) };
  }));
}

export function deliveryFileReference(input: { artifactId: string; file: AgentFile; sha256?: string }): DiscordDeliveryFileReference {
  return discordDeliveryFileReferenceSchema.parse({
    artifactId: input.artifactId,
    name: input.file.name,
    contentType: input.file.contentType,
    sizeBytes: input.file.data.length,
    sha256: input.sha256 ?? createHash("sha256").update(input.file.data).digest("hex"),
  });
}
