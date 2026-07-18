import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { DiscordPresentation } from "./types.js";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const snowflake = z.string().regex(/^\d{15,22}$/);
const mediaUrl = z.string().trim().min(1).max(2_048).refine(
  (value) => /^https?:\/\//i.test(value) || /^attachment:\/\/[^/\\]+$/.test(value),
  "Media must use an HTTP(S) or attachment:// URL.",
);
const emoji = z.object({ id: snowflake.optional(), name: z.string().min(1).max(128).optional(), animated: z.boolean().optional() }).refine((v) => Boolean(v.id || v.name));
const continueAction = z.object({ type: z.literal("continue"), prompt: shortText(2_000), singleUse: z.boolean().optional() });
const modalAction: z.ZodTypeAny = z.lazy(() => z.object({ type: z.literal("modal"), prompt: shortText(2_000), modal: modal, singleUse: z.boolean().optional() }));
const button: z.ZodTypeAny = z.union([
  z.object({ type: z.literal("button"), label: shortText(80).optional(), emoji: emoji.optional(), disabled: z.boolean().optional(), style: z.enum(["primary", "secondary", "success", "danger"]), action: z.union([continueAction, modalAction]) }),
  z.object({ type: z.literal("button"), label: shortText(80).optional(), emoji: emoji.optional(), disabled: z.boolean().optional(), style: z.literal("link"), url: z.string().url().max(512) }),
  z.object({ type: z.literal("button"), disabled: z.boolean().optional(), style: z.literal("premium"), skuId: snowflake }),
]).superRefine((value, ctx) => {
  if (value.style !== "premium" && !value.label && !value.emoji) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A button requires a label or emoji." });
});
const selectOption = z.object({ label: shortText(100), value: shortText(100), description: shortText(100).optional(), emoji: emoji.optional(), default: z.boolean().optional() });
const selectBase = { placeholder: shortText(150).optional(), minValues: z.number().int().min(0).max(25).optional(), maxValues: z.number().int().min(1).max(25).optional(), disabled: z.boolean().optional(), prompt: shortText(2_000), singleUse: z.boolean().optional() };
const defaultValue = (type: z.ZodTypeAny) => z.object({ id: snowflake, type });
const select: z.ZodTypeAny = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string_select"), ...selectBase, options: z.array(selectOption).min(1).max(25) }),
  z.object({ type: z.literal("user_select"), ...selectBase, defaultValues: z.array(defaultValue(z.literal("user"))).max(25).optional() }),
  z.object({ type: z.literal("role_select"), ...selectBase, defaultValues: z.array(defaultValue(z.literal("role"))).max(25).optional() }),
  z.object({ type: z.literal("mentionable_select"), ...selectBase, defaultValues: z.array(defaultValue(z.enum(["user", "role"]))).max(25).optional() }),
  z.object({ type: z.literal("channel_select"), ...selectBase, channelTypes: z.array(z.number().int().min(0).max(16)).max(16).optional(), defaultValues: z.array(defaultValue(z.literal("channel"))).max(25).optional() }),
]).superRefine((value, ctx) => {
  validateChoiceCardinality(value, ctx, {
    availableCount: value.type === "string_select" ? value.options.length : undefined,
    defaults: choiceDefaults(value),
  });
  validateUniqueDefaults(value, ctx);
  if (value.type === "string_select") validateUniqueOptionValues(value.options, ctx);
});
const text = z.object({ type: z.literal("text"), content: shortText(4_000) });
const thumbnail = z.object({ type: z.literal("thumbnail"), url: mediaUrl, description: z.string().max(1_024).optional(), spoiler: z.boolean().optional() });
const gallery = z.object({ type: z.literal("media_gallery"), items: z.array(z.object({ url: mediaUrl, description: z.string().max(1_024).optional(), spoiler: z.boolean().optional() })).min(1).max(10) });
const file = z.object({ type: z.literal("file"), url: z.string().regex(/^attachment:\/\/[^/\\]+$/).max(2_048), spoiler: z.boolean().optional() });
const separator = z.object({ type: z.literal("separator"), divider: z.boolean().optional(), spacing: z.enum(["small", "large"]).optional() });
const actionRow = z.object({ type: z.literal("action_row"), components: z.array(z.union([button, select])).min(1).max(5) }).superRefine((row, ctx) => {
  const selects = row.components.filter((item: { type: string }) => item.type.endsWith("_select"));
  if (selects.length > 0 && row.components.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An action row containing a select must contain only that select." });
});
const section: z.ZodTypeAny = z.object({ type: z.literal("section"), text: z.array(shortText(4_000)).min(1).max(3), accessory: z.union([button, thumbnail]) });
const containerChild: z.ZodTypeAny = z.lazy(() => z.union([actionRow, file, gallery, section, separator, text]));
const container = z.object({ type: z.literal("container"), accentColor: z.number().int().min(0).max(0xffffff).optional(), spoiler: z.boolean().optional(), components: z.array(containerChild).min(1).max(40) });

const modalSelectBase = { key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), placeholder: shortText(150).optional(), required: z.boolean().optional(), minValues: z.number().int().min(0).max(25).optional(), maxValues: z.number().int().min(1).max(25).optional() };
const modalField: z.ZodTypeAny = z.discriminatedUnion("type", [
  text,
  z.object({ type: z.literal("text_input"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), style: z.enum(["short", "paragraph"]).optional(), placeholder: z.string().max(100).optional(), value: z.string().max(4_000).optional(), required: z.boolean().optional(), minLength: z.number().int().min(0).max(4_000).optional(), maxLength: z.number().int().min(1).max(4_000).optional() }),
  z.object({ type: z.literal("string_select"), ...modalSelectBase, options: z.array(selectOption).min(1).max(25) }),
  z.object({ type: z.literal("user_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.literal("user"))).max(25).optional() }),
  z.object({ type: z.literal("role_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.literal("role"))).max(25).optional() }),
  z.object({ type: z.literal("mentionable_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.enum(["user", "role"]))).max(25).optional() }),
  z.object({ type: z.literal("channel_select"), ...modalSelectBase, channelTypes: z.array(z.number().int().min(0).max(16)).max(16).optional(), defaultValues: z.array(defaultValue(z.literal("channel"))).max(25).optional() }),
  z.object({ type: z.literal("file_upload"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), required: z.boolean().optional(), minValues: z.number().int().min(0).max(10).optional(), maxValues: z.number().int().min(1).max(10).optional() }),
  z.object({ type: z.literal("radio_group"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), required: z.boolean().optional(), options: z.array(z.object({ label: shortText(100), value: shortText(100), description: z.string().max(100).optional(), default: z.boolean().optional() })).min(2).max(10) }),
  z.object({ type: z.literal("checkbox_group"), ...modalSelectBase, maxValues: z.number().int().min(1).max(10).optional(), options: z.array(z.object({ label: shortText(100), value: shortText(100), description: z.string().max(100).optional(), default: z.boolean().optional() })).min(1).max(10) }),
  z.object({ type: z.literal("checkbox"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), default: z.boolean().optional() }),
]);
const modal = z.object({ title: shortText(45), fields: z.array(modalField).min(1).max(5) }).superRefine((value, ctx) => {
  const keys = value.fields.flatMap((field: { type: string; key?: string }) => field.type === "text" || !field.key ? [] : [field.key]);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Modal field keys must be unique." });
  for (const field of value.fields as Array<Record<string, any>>) {
    if (field.type === "text_input" && field.minLength != null && field.maxLength != null && field.minLength > field.maxLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Text input minLength cannot exceed maxLength." });
    }
    if (supportsChoiceCardinality(field.type)) {
      validateChoiceCardinality(field, ctx, {
        availableCount: Array.isArray(field.options) ? field.options.length : undefined,
        defaultMax: field.type === "checkbox_group" ? field.options.length : 1,
        defaults: choiceDefaults(field),
        requiredSupported: true,
      });
      validateUniqueDefaults(field, ctx);
      if (Array.isArray(field.options)) validateUniqueOptionValues(field.options, ctx);
    }
    if (field.type === "radio_group") {
      validateUniqueOptionValues(field.options, ctx);
      if ((field.options as Array<{ default?: boolean }>).filter((option) => option.default).length > 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A radio group can have at most one default option." });
      }
    }
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

/** The model and runtime share one schema so Discord protocol constraints cannot drift. */
export const discordPresentationToolParameters = zodToJsonSchema(discordPresentationSchema, {
  target: "openApi3",
  $refStrategy: "root",
}) as Record<string, unknown>;

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

type ChoiceCardinalityValue = {
  required?: boolean;
  minValues?: number;
  maxValues?: number;
};

type ChoiceDefaults = {
  count: number;
  provided: boolean;
};

function validateChoiceCardinality(
  value: ChoiceCardinalityValue,
  ctx: z.RefinementCtx,
  rules: {
    availableCount?: number;
    defaultMax?: number;
    defaults?: ChoiceDefaults;
    requiredSupported?: boolean;
  } = {},
) {
  const effectiveMin = value.minValues ?? 1;
  const effectiveMax = value.maxValues ?? rules.defaultMax ?? 1;
  if (effectiveMin > effectiveMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minValues cannot exceed maxValues." });
  }
  if (rules.requiredSupported && value.required !== false && effectiveMin === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A required choice cannot have minValues 0." });
  }
  if (rules.availableCount != null && effectiveMax > rules.availableCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "maxValues cannot exceed the number of available options." });
  }
  if (rules.availableCount != null && effectiveMin > rules.availableCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minValues cannot exceed the number of available options." });
  }
  if (rules.defaults?.provided && (rules.defaults.count < effectiveMin || rules.defaults.count > effectiveMax)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The number of default values must be within minValues and maxValues." });
  }
}

function choiceDefaults(value: Record<string, any>): ChoiceDefaults {
  if (Array.isArray(value.defaultValues)) return { count: value.defaultValues.length, provided: true };
  if (Array.isArray(value.options)) {
    const count = value.options.filter((option: { default?: boolean }) => option.default).length;
    return { count, provided: count > 0 };
  }
  return { count: 0, provided: false };
}

function validateUniqueDefaults(value: Record<string, any>, ctx: z.RefinementCtx) {
  if (!Array.isArray(value.defaultValues)) return;
  const keys = value.defaultValues.map((item: { id: string; type: string }) => `${item.type}:${item.id}`);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Default values must be unique." });
  }
}

function validateUniqueOptionValues(options: Array<{ value: string }>, ctx: z.RefinementCtx) {
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Option values must be unique." });
  }
}

function supportsChoiceCardinality(type: string) {
  return type === "string_select"
    || type === "user_select"
    || type === "role_select"
    || type === "mentionable_select"
    || type === "channel_select"
    || type === "file_upload"
    || type === "checkbox_group";
}
