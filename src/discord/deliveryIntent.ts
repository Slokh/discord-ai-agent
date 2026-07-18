import { z } from "zod";
import type { DiscordResponseFooter } from "./responseSink.js";
import { discordPresentationSchema, type DiscordPresentation } from "./components/validation.js";
import type { AgentFile } from "../tools/types.js";
import { validateDiscordAttachmentNames } from "./components/renderer.js";

export const DISCORD_DELIVERY_INTENT_ARTIFACT_KIND = "discord_delivery_intent";

const discordDeliveryIntentSchema = z.object({
  schemaVersion: z.literal(1),
  content: z.string(),
  storedContent: z.string(),
  responseRedacted: z.boolean(),
  footer: z.object({
    traceUrl: z.string().url().nullable().optional(),
    durationMs: z.number().nonnegative().nullable().optional(),
    extraLines: z.array(z.string()).optional(),
  }).nullable(),
  presentation: discordPresentationSchema.nullable(),
  files: z.array(z.object({
    name: z.string().min(1),
    contentType: z.string().optional(),
    dataBase64: z.string(),
  })).max(10),
  sourceMessageReaction: z.string().nullable(),
});

export type DiscordDeliveryIntent = z.infer<typeof discordDeliveryIntentSchema>;

export function createDiscordDeliveryIntent(input: {
  content: string;
  storedContent?: string;
  footer?: DiscordResponseFooter | null;
  presentation?: DiscordPresentation | null;
  files?: AgentFile[];
  sourceMessageReaction?: string | null;
}): DiscordDeliveryIntent {
  validateDiscordAttachmentNames(input.files?.map((file) => file.name) ?? []);
  return discordDeliveryIntentSchema.parse({
    schemaVersion: 1,
    // Explicitly redacted responses remain redacted at rest. Recovery favors privacy over reproducing secret text.
    content: input.storedContent ?? input.content,
    storedContent: input.storedContent ?? input.content,
    responseRedacted: input.storedContent !== undefined,
    footer: input.footer ?? null,
    presentation: input.presentation ?? null,
    files: (input.files ?? []).map((file) => ({
      name: file.name,
      ...(file.contentType ? { contentType: file.contentType } : {}),
      dataBase64: file.data.toString("base64"),
    })),
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

export function discordDeliveryIntentFiles(intent: DiscordDeliveryIntent): AgentFile[] {
  return intent.files.map((file) => ({
    name: file.name,
    data: Buffer.from(file.dataBase64, "base64"),
    ...(file.contentType ? { contentType: file.contentType } : {}),
  }));
}
