import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const snowflake = z.string().regex(/^\d{15,22}$/);
const mediaUrl = z.string().trim().min(1).max(2_048).refine(
  (value) => /^https?:\/\//i.test(value) || /^attachment:\/\/[^/\\]+$/.test(value),
  "Media must use an HTTP(S) or attachment:// URL.",
);
const emojiSchema = z.object({
  id: snowflake.optional(),
  name: z.string().min(1).max(128).optional(),
  animated: z.boolean().optional(),
}).refine((value) => Boolean(value.id || value.name));

export const discordButtonStyleSchema = z.enum(["primary", "secondary", "success", "danger"]);
export const discordSelectOptionSchema = z.object({
  label: shortText(100),
  value: shortText(100),
  description: shortText(100).optional(),
  emoji: emojiSchema.optional(),
  default: z.boolean().optional(),
});
const modalOptionSchema = z.object({
  label: shortText(100),
  value: shortText(100),
  description: z.string().max(100).optional(),
  default: z.boolean().optional(),
});
const defaultValue = <T extends z.ZodTypeAny>(type: T) => z.object({ id: snowflake, type });
const textDisplaySchema = z.object({ type: z.literal("text"), content: shortText(4_000) });
const modalSelectBase = {
  key: shortText(100),
  label: shortText(45),
  description: z.string().max(100).optional(),
  placeholder: shortText(150).optional(),
  required: z.boolean().optional(),
  minValues: z.number().int().min(0).max(25).optional(),
  maxValues: z.number().int().min(1).max(25).optional(),
};

export const discordModalFieldSchema = z.discriminatedUnion("type", [
  textDisplaySchema,
  z.object({
    type: z.literal("text_input"), key: shortText(100), label: shortText(45),
    description: z.string().max(100).optional(), style: z.enum(["short", "paragraph"]).optional(),
    placeholder: z.string().max(100).optional(), value: z.string().max(4_000).optional(),
    required: z.boolean().optional(), minLength: z.number().int().min(0).max(4_000).optional(),
    maxLength: z.number().int().min(1).max(4_000).optional(),
  }),
  z.object({ type: z.literal("string_select"), ...modalSelectBase, options: z.array(discordSelectOptionSchema).min(1).max(25) }),
  z.object({ type: z.literal("user_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.literal("user"))).max(25).optional() }),
  z.object({ type: z.literal("role_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.literal("role"))).max(25).optional() }),
  z.object({ type: z.literal("mentionable_select"), ...modalSelectBase, defaultValues: z.array(defaultValue(z.enum(["user", "role"]))).max(25).optional() }),
  z.object({ type: z.literal("channel_select"), ...modalSelectBase, channelTypes: z.array(z.number().int().min(0).max(16)).max(16).optional(), defaultValues: z.array(defaultValue(z.literal("channel"))).max(25).optional() }),
  z.object({
    type: z.literal("file_upload"), key: shortText(100), label: shortText(45),
    description: z.string().max(100).optional(), required: z.boolean().optional(),
    minValues: z.number().int().min(0).max(10).optional(), maxValues: z.number().int().min(1).max(10).optional(),
  }),
  z.object({ type: z.literal("radio_group"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), required: z.boolean().optional(), options: z.array(modalOptionSchema).min(2).max(10) }),
  z.object({ type: z.literal("checkbox_group"), ...modalSelectBase, maxValues: z.number().int().min(1).max(10).optional(), options: z.array(modalOptionSchema).min(1).max(10) }),
  z.object({ type: z.literal("checkbox"), key: shortText(100), label: shortText(45), description: z.string().max(100).optional(), default: z.boolean().optional() }),
]).superRefine((field, ctx) => {
  if (field.type === "text_input" && field.minLength != null && field.maxLength != null && field.minLength > field.maxLength) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Text input minLength cannot exceed maxLength." });
  }
  if (supportsChoiceCardinality(field)) {
    validateChoiceCardinality(field, ctx, {
      availableCount: "options" in field ? field.options.length : undefined,
      defaultMax: field.type === "checkbox_group" ? field.options.length : 1,
      defaults: choiceDefaults(field),
      requiredSupported: true,
    });
    validateUniqueDefaults(field, ctx);
    if ("options" in field) validateUniqueOptionValues(field.options, ctx);
  }
  if (field.type === "radio_group") {
    validateUniqueOptionValues(field.options, ctx);
    if (field.options.filter((option) => option.default).length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A radio group can have at most one default option." });
    }
  }
});

export const discordModalSchema = z.object({
  title: shortText(45),
  fields: z.array(discordModalFieldSchema).min(1).max(5),
}).superRefine((value, ctx) => {
  const keys = value.fields.flatMap((field) => field.type === "text" ? [] : [field.key]);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Modal field keys must be unique." });
  }
});

export const discordContinueActionSchema = z.object({
  type: z.literal("continue"), prompt: shortText(2_000), singleUse: z.boolean().optional(),
});
export const discordModalActionSchema = z.object({
  type: z.literal("modal"), prompt: shortText(2_000), modal: discordModalSchema, singleUse: z.boolean().optional(),
});
export const discordButtonSchema = z.union([
  z.object({
    type: z.literal("button"), label: shortText(80).optional(), emoji: emojiSchema.optional(),
    disabled: z.boolean().optional(), style: discordButtonStyleSchema,
    action: z.union([discordContinueActionSchema, discordModalActionSchema]),
  }),
  z.object({
    type: z.literal("button"), label: shortText(80).optional(), emoji: emojiSchema.optional(),
    disabled: z.boolean().optional(), style: z.literal("link"), url: z.string().url().max(512),
  }),
  z.object({ type: z.literal("button"), disabled: z.boolean().optional(), style: z.literal("premium"), skuId: snowflake }),
]).superRefine((value, ctx) => {
  if (value.style !== "premium" && !value.label && !value.emoji) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A button requires a label or emoji." });
  }
});

const selectBase = {
  placeholder: shortText(150).optional(), minValues: z.number().int().min(0).max(25).optional(),
  maxValues: z.number().int().min(1).max(25).optional(), disabled: z.boolean().optional(),
  prompt: shortText(2_000), singleUse: z.boolean().optional(),
};
export const discordSelectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string_select"), ...selectBase, options: z.array(discordSelectOptionSchema).min(1).max(25) }),
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

export const discordTextDisplaySchema = textDisplaySchema;
export const discordThumbnailSchema = z.object({ type: z.literal("thumbnail"), url: mediaUrl, description: z.string().max(1_024).optional(), spoiler: z.boolean().optional() });
export const discordMediaGallerySchema = z.object({ type: z.literal("media_gallery"), items: z.array(z.object({ url: mediaUrl, description: z.string().max(1_024).optional(), spoiler: z.boolean().optional() })).min(1).max(10) });
export const discordFileDisplaySchema = z.object({ type: z.literal("file"), url: z.string().regex(/^attachment:\/\/[^/\\]+$/).max(2_048), spoiler: z.boolean().optional() });
export const discordSeparatorSchema = z.object({ type: z.literal("separator"), divider: z.boolean().optional(), spacing: z.enum(["small", "large"]).optional() });
export const discordActionRowSchema = z.object({
  type: z.literal("action_row"),
  components: z.array(z.union([discordButtonSchema, discordSelectSchema])).min(1).max(5),
}).superRefine((row, ctx) => {
  const selects = row.components.filter((item) => item.type.endsWith("_select"));
  if (selects.length > 0 && row.components.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An action row containing a select must contain only that select." });
  }
});
export const discordSectionSchema = z.object({
  type: z.literal("section"), text: z.array(shortText(4_000)).min(1).max(3),
  accessory: z.union([discordButtonSchema, discordThumbnailSchema]),
});
export const discordContainerChildSchema = z.union([
  discordActionRowSchema, discordFileDisplaySchema, discordMediaGallerySchema,
  discordSectionSchema, discordSeparatorSchema, discordTextDisplaySchema,
]);
export const discordContainerSchema = z.object({
  type: z.literal("container"), accentColor: z.number().int().min(0).max(0xffffff).optional(),
  spoiler: z.boolean().optional(), components: z.array(discordContainerChildSchema).min(1).max(40),
});
export const discordMessageComponentSchema = z.union([
  discordActionRowSchema, discordContainerSchema, discordFileDisplaySchema,
  discordMediaGallerySchema, discordSectionSchema, discordSeparatorSchema, discordTextDisplaySchema,
]);

export const discordPresentationSchema = z.object({
  version: z.literal(1).default(1),
  audience: z.enum(["requester", "channel"]).default("requester"),
  expiresInMinutes: z.number().int().min(1).max(10_080).optional(),
  components: z.array(discordMessageComponentSchema).min(1).max(40),
}).superRefine((presentation, ctx) => {
  if (countComponents(presentation.components) > 40) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Discord allows at most 40 components in a Components V2 message." });
  }
});

export const discordStoredComponentActionV1Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("continue"), prompt: shortText(2_000) }),
  z.object({ type: z.literal("select"), prompt: shortText(2_000) }),
  z.object({ type: z.literal("modal"), prompt: shortText(2_000), modal: discordModalSchema }),
]);

export type DiscordComponentAudience = z.infer<typeof discordPresentationSchema>["audience"];
export type DiscordButtonStyle = z.infer<typeof discordButtonStyleSchema>;
export type DiscordContinueAction = z.infer<typeof discordContinueActionSchema>;
export type DiscordModalAction = z.infer<typeof discordModalActionSchema>;
export type DiscordButtonSpec = z.infer<typeof discordButtonSchema>;
export type DiscordSelectOptionSpec = z.infer<typeof discordSelectOptionSchema>;
export type DiscordSelectSpec = z.infer<typeof discordSelectSchema>;
export type DiscordTextDisplaySpec = z.infer<typeof discordTextDisplaySchema>;
export type DiscordThumbnailSpec = z.infer<typeof discordThumbnailSchema>;
export type DiscordMediaGallerySpec = z.infer<typeof discordMediaGallerySchema>;
export type DiscordFileDisplaySpec = z.infer<typeof discordFileDisplaySchema>;
export type DiscordSeparatorSpec = z.infer<typeof discordSeparatorSchema>;
export type DiscordActionRowSpec = z.infer<typeof discordActionRowSchema>;
export type DiscordSectionSpec = z.infer<typeof discordSectionSchema>;
export type DiscordContainerChildSpec = z.infer<typeof discordContainerChildSchema>;
export type DiscordContainerSpec = z.infer<typeof discordContainerSchema>;
export type DiscordMessageComponentSpec = z.infer<typeof discordMessageComponentSchema>;
export type DiscordModalFieldSpec = z.infer<typeof discordModalFieldSchema>;
export type DiscordModalSpec = z.infer<typeof discordModalSchema>;
export type DiscordPresentation = z.infer<typeof discordPresentationSchema>;
export type DiscordStoredComponentAction = z.infer<typeof discordStoredComponentActionV1Schema>;

export function parseDiscordPresentation(value: unknown): DiscordPresentation {
  return discordPresentationSchema.parse(value);
}

export function parseDiscordStoredComponentActionV1(value: unknown): DiscordStoredComponentAction {
  return discordStoredComponentActionV1Schema.parse(value);
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

type ChoiceCardinalityValue = { required?: boolean; minValues?: number; maxValues?: number };
type ChoiceDefaults = { count: number; provided: boolean };

function validateChoiceCardinality(
  value: ChoiceCardinalityValue,
  ctx: z.RefinementCtx,
  rules: { availableCount?: number; defaultMax?: number; defaults?: ChoiceDefaults; requiredSupported?: boolean } = {},
) {
  const effectiveMin = value.minValues ?? 1;
  const effectiveMax = value.maxValues ?? rules.defaultMax ?? 1;
  if (effectiveMin > effectiveMax) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minValues cannot exceed maxValues." });
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

function choiceDefaults(value: unknown): ChoiceDefaults {
  if (!isRecord(value)) return { count: 0, provided: false };
  if (Array.isArray(value.defaultValues)) return { count: value.defaultValues.length, provided: true };
  if (Array.isArray(value.options)) {
    const count = value.options.filter((option) => isRecord(option) && option.default === true).length;
    return { count, provided: count > 0 };
  }
  return { count: 0, provided: false };
}

function validateUniqueDefaults(value: unknown, ctx: z.RefinementCtx) {
  if (!isRecord(value) || !Array.isArray(value.defaultValues)) return;
  const keys = value.defaultValues.map((item) => isRecord(item) ? `${String(item.type)}:${String(item.id)}` : "invalid");
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Default values must be unique." });
}

function validateUniqueOptionValues(options: Array<{ value: string }>, ctx: z.RefinementCtx) {
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Option values must be unique." });
  }
}

function supportsChoiceCardinality(value: { type: string }): value is typeof value & ChoiceCardinalityValue {
  return value.type === "string_select" || value.type === "user_select" || value.type === "role_select"
    || value.type === "mentionable_select" || value.type === "channel_select" || value.type === "file_upload"
    || value.type === "checkbox_group";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
