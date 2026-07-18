import { z } from "zod";
import type { DiscordPresentation } from "./types.js";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const emoji = z.object({ id: z.string().optional(), name: z.string().optional(), animated: z.boolean().optional() }).refine((v) => Boolean(v.id || v.name));
const continueAction = z.object({ type: z.literal("continue"), prompt: shortText(2_000), singleUse: z.boolean().optional() });
const modalAction: z.ZodTypeAny = z.lazy(() => z.object({ type: z.literal("modal"), prompt: shortText(2_000), modal: modal, singleUse: z.boolean().optional() }));
const button: z.ZodTypeAny = z.union([
  z.object({ type: z.literal("button"), label: shortText(80).optional(), emoji: emoji.optional(), disabled: z.boolean().optional(), style: z.enum(["primary", "secondary", "success", "danger"]), action: z.union([continueAction, modalAction]) }),
  z.object({ type: z.literal("button"), label: shortText(80), emoji: emoji.optional(), disabled: z.boolean().optional(), style: z.literal("link"), url: z.string().url().max(512) }),
  z.object({ type: z.literal("button"), disabled: z.boolean().optional(), style: z.literal("premium"), skuId: z.string().regex(/^\d{15,22}$/) }),
]).superRefine((value, ctx) => {
  if (value.style !== "premium" && !value.label && !value.emoji) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A button requires a label or emoji." });
});
const selectOption = z.object({ label: shortText(100), value: shortText(100), description: shortText(100).optional(), emoji: emoji.optional(), default: z.boolean().optional() });
const selectBase = { placeholder: shortText(150).optional(), minValues: z.number().int().min(0).max(25).optional(), maxValues: z.number().int().min(1).max(25).optional(), disabled: z.boolean().optional(), prompt: shortText(2_000), singleUse: z.boolean().optional() };
const defaultValue = (type: z.ZodTypeAny) => z.object({ id: shortText(32), type });
const select: z.ZodTypeAny = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string_select"), ...selectBase, options: z.array(selectOption).min(1).max(25) }),
  z.object({ type: z.literal("user_select"), ...selectBase, defaultValues: z.array(defaultValue(z.literal("user"))).max(25).optional() }),
  z.object({ type: z.literal("role_select"), ...selectBase, defaultValues: z.array(defaultValue(z.literal("role"))).max(25).optional() }),
  z.object({ type: z.literal("mentionable_select"), ...selectBase, defaultValues: z.array(defaultValue(z.enum(["user", "role"]))).max(25).optional() }),
  z.object({ type: z.literal("channel_select"), ...selectBase, channelTypes: z.array(z.number().int().min(0).max(16)).max(16).optional(), defaultValues: z.array(defaultValue(z.literal("channel"))).max(25).optional() }),
]).superRefine((value, ctx) => {
  if (value.minValues != null && value.maxValues != null && value.minValues > value.maxValues) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minValues cannot exceed maxValues." });
  if (value.type === "string_select" && new Set(value.options.map((option: { value: string }) => option.value)).size !== value.options.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "String select option values must be unique." });
});
const text = z.object({ type: z.literal("text"), content: shortText(4_000) });
const thumbnail = z.object({ type: z.literal("thumbnail"), url: shortText(2_048), description: z.string().max(1_024).optional(), spoiler: z.boolean().optional() });
const gallery = z.object({ type: z.literal("media_gallery"), items: z.array(z.object({ url: shortText(2_048), description: z.string().max(1_024).optional(), spoiler: z.boolean().optional() })).min(1).max(10) });
const file = z.object({ type: z.literal("file"), url: z.string().regex(/^attachment:\/\/[^/\\]+$/).max(2_048), spoiler: z.boolean().optional() });
const separator = z.object({ type: z.literal("separator"), divider: z.boolean().optional(), spacing: z.enum(["small", "large"]).optional() });
const actionRow = z.object({ type: z.literal("action_row"), components: z.array(z.union([button, select])).min(1).max(5) }).superRefine((row, ctx) => {
  const selects = row.components.filter((item: { type: string }) => item.type.endsWith("_select"));
  if (selects.length > 0 && row.components.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An action row containing a select must contain only that select." });
});
const section: z.ZodTypeAny = z.object({ type: z.literal("section"), text: z.array(shortText(4_000)).min(1).max(3), accessory: z.union([button, thumbnail]) });
const containerChild: z.ZodTypeAny = z.lazy(() => z.union([actionRow, file, gallery, section, separator, text]));
const container = z.object({ type: z.literal("container"), accentColor: z.number().int().min(0).max(0xffffff).optional(), spoiler: z.boolean().optional(), components: z.array(containerChild).min(1).max(40) });

const modalSelectBase = { key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), required: z.boolean().optional(), minValues: z.number().int().min(0).max(25).optional(), maxValues: z.number().int().min(1).max(25).optional() };
const modalField: z.ZodTypeAny = z.discriminatedUnion("type", [
  text,
  z.object({ type: z.literal("text_input"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), style: z.enum(["short", "paragraph"]).optional(), placeholder: z.string().max(100).optional(), value: z.string().max(4_000).optional(), required: z.boolean().optional(), minLength: z.number().int().min(0).max(4_000).optional(), maxLength: z.number().int().min(1).max(4_000).optional() }),
  z.object({ type: z.literal("string_select"), ...modalSelectBase, options: z.array(selectOption).min(1).max(25) }),
  z.object({ type: z.literal("user_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.literal("user"))).max(25).optional() }),
  z.object({ type: z.literal("role_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.literal("role"))).max(25).optional() }),
  z.object({ type: z.literal("mentionable_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.enum(["user", "role"]))).max(25).optional() }),
  z.object({ type: z.literal("channel_select"), ...modalSelectBase, channelTypes: z.array(z.number().int().min(0).max(16)).max(16).optional(), defaultValues: z.array(defaultValue(z.literal("channel"))).max(25).optional() }),
  z.object({ type: z.literal("file_upload"), ...modalSelectBase, maxValues: z.number().int().min(1).max(10).optional() }),
  z.object({ type: z.literal("radio_group"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), required: z.boolean().optional(), options: z.array(z.object({ label: shortText(100), value: shortText(100), description: z.string().max(100).optional(), default: z.boolean().optional() })).min(2).max(10) }),
  z.object({ type: z.literal("checkbox_group"), ...modalSelectBase, maxValues: z.number().int().min(1).max(10).optional(), options: z.array(z.object({ label: shortText(100), value: shortText(100), description: z.string().max(100).optional(), default: z.boolean().optional() })).min(1).max(10) }),
  z.object({ type: z.literal("checkbox"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), required: z.boolean().optional(), default: z.boolean().optional() }),
]);
const modal = z.object({ title: shortText(45), fields: z.array(modalField).min(1).max(5) }).superRefine((value, ctx) => {
  const keys = value.fields.flatMap((field: { type: string; key?: string }) => field.type === "text" || !field.key ? [] : [field.key]);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Modal field keys must be unique." });
  for (const field of value.fields as Array<{ minValues?: number; maxValues?: number }>) {
    if (field.minValues != null && field.maxValues != null && field.minValues > field.maxValues) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Modal minValues cannot exceed maxValues." });
  }
});

export const discordPresentationSchema = z.object({
  version: z.literal(1).default(1),
  audience: z.enum(["requester", "channel"]).default("requester"),
  expiresInMinutes: z.number().int().min(1).max(10_080).optional(),
  components: z.array(z.union([actionRow, container, file, gallery, section, separator, text])).min(1).max(40),
}).superRefine((presentation, ctx) => {
  if (countComponents(presentation.components) > 40) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Discord allows at most 40 components in a Components V2 message." });
});

export function parseDiscordPresentation(value: unknown): DiscordPresentation {
  return discordPresentationSchema.parse(value) as DiscordPresentation;
}

function countComponents(components: unknown[]): number {
  let count = 0;
  for (const component of components as Array<{ components?: unknown[]; text?: unknown[]; accessory?: unknown }>) {
    count += 1;
    if (Array.isArray(component.components)) count += countComponents(component.components);
    if (Array.isArray(component.text)) count += component.text.length;
    if (component.accessory) count += 1;
  }
  return count;
}
