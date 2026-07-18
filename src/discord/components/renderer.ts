import { randomBytes } from "node:crypto";
import { MessageFlags, ModalBuilder, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import { splitForDiscord } from "../../util/text.js";
import type {
  DiscordActionRowSpec,
  DiscordButtonSpec,
  DiscordContainerChildSpec,
  DiscordMessageComponentSpec,
  DiscordModalFieldSpec,
  DiscordModalSpec,
  DiscordPresentation,
  DiscordSelectSpec,
  DiscordStoredComponentAction,
} from "./types.js";

export type DiscordActionRegistration = {
  token: string;
  customId: string;
  action: DiscordStoredComponentAction;
  singleUse: boolean;
};

export type PreparedDiscordPresentation = {
  payload: MessageCreateOptions | MessageEditOptions;
  fallbackPayload: MessageCreateOptions | MessageEditOptions;
  registrations: DiscordActionRegistration[];
};

/** Purely compiles a validated semantic presentation. Persistence and delivery happen later. */
export function prepareDiscordPresentation(input: {
  presentation: DiscordPresentation;
  content: string;
  footer?: string | null;
  fileNames?: string[];
  tokenFactory?: () => string;
}): PreparedDiscordPresentation {
  const registrations: DiscordActionRegistration[] = [];
  const tokenFactory = input.tokenFactory ?? (() => randomBytes(18).toString("base64url"));
  const displayedFiles = new Set(collectReferencedAttachmentNames(input.presentation.components));
  const availableFiles = new Set(input.fileNames ?? []);
  for (const name of displayedFiles) {
    if (!availableFiles.has(name)) throw new Error(`Discord file component references missing attachment: ${name}`);
  }

  const automaticFileNames = [...availableFiles].filter((name) => !displayedFiles.has(name));
  const bodyComponents = textDisplayComponents(input.content);
  const footerComponents = textDisplayComponents(input.footer ?? "");
  const projectedCount = bodyComponents.length
    + countSemanticComponents(input.presentation.components)
    + automaticFileNames.length
    + footerComponents.length;
  if (projectedCount > 40) {
    throw new Error(`Discord Components V2 allows at most 40 total components; compiled response has ${projectedCount}.`);
  }

  const register = (action: DiscordStoredComponentAction, singleUse = false) => {
    const token = tokenFactory();
    const kind = action.type === "modal" ? "m" : "a";
    const customId = `ai:v1:${kind}:${token}`;
    registrations.push({ token, customId, action, singleUse });
    return customId;
  };
  const components: any[] = [...bodyComponents];
  for (const component of input.presentation.components) components.push(compileMessageComponent(component, register));
  for (const name of automaticFileNames) components.push({ type: 13, file: { url: `attachment://${name}` } });
  components.push(...footerComponents);

  return {
    payload: componentsV2Payload(components),
    fallbackPayload: plainDiscordComponentsV2Payload({
      content: input.content.trim() || "Done.",
      footer: input.footer,
      fileNames: input.fileNames,
    }),
    registrations,
  };
}

export function plainDiscordComponentsV2Payload(input: {
  content: string;
  footer?: string | null;
  fileNames?: string[];
}): MessageCreateOptions | MessageEditOptions {
  const components: any[] = [
    ...textDisplayComponents(input.content.trim() || "Done."),
    ...(input.fileNames ?? []).map((name) => ({ type: 13, file: { url: `attachment://${name}` } })),
    ...textDisplayComponents(input.footer ?? ""),
  ];
  if (countCompiledComponents(components) > 40) throw new Error("Discord Components V2 fallback exceeds the 40-component limit.");
  return componentsV2Payload(components);
}

function componentsV2Payload(components: any[]): MessageCreateOptions | MessageEditOptions {
  return {
    content: null,
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: components as any,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

function textDisplayComponents(value: string): Array<{ type: 10; content: string }> {
  const trimmed = value.trim();
  return trimmed ? splitForDiscord(trimmed, 4_000).map((content) => ({ type: 10 as const, content })) : [];
}

function countSemanticComponents(components: Array<DiscordMessageComponentSpec | DiscordContainerChildSpec>): number {
  let count = 0;
  for (const component of components) {
    count += 1;
    if (component.type === "container") count += countSemanticComponents(component.components);
    if (component.type === "action_row") count += component.components.length;
    if (component.type === "section") count += component.text.length + 1;
  }
  return count;
}

function countCompiledComponents(components: any[]): number {
  return components.reduce((total, component) => {
    const nested = Array.isArray(component.components) ? countCompiledComponents(component.components) : 0;
    return total + 1 + nested + (component.accessory ? 1 : 0);
  }, 0);
}

function collectReferencedAttachmentNames(components: DiscordMessageComponentSpec[]): string[] {
  const names: string[] = [];
  const collectUrl = (url: string) => {
    if (url.startsWith("attachment://")) names.push(url.slice("attachment://".length));
  };
  const visit = (component: DiscordMessageComponentSpec | DiscordContainerChildSpec) => {
    if (component.type === "file") collectUrl(component.url);
    if (component.type === "media_gallery") component.items.forEach((item) => collectUrl(item.url));
    if (component.type === "section" && component.accessory.type === "thumbnail") collectUrl(component.accessory.url);
    if (component.type === "container") component.components.forEach(visit);
  };
  components.forEach(visit);
  return names;
}

export function buildDiscordModal(customId: string, modal: DiscordModalSpec): ModalBuilder {
  return ModalBuilder.from({
    custom_id: `${customId}:submit`,
    title: modal.title,
    components: modal.fields.map(compileModalField),
  } as any);
}

function compileMessageComponent(
  component: DiscordMessageComponentSpec | DiscordContainerChildSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => string,
): any {
  switch (component.type) {
    case "text": return { type: 10, content: component.content };
    case "action_row": return compileActionRow(component, register);
    case "section": return {
      type: 9,
      components: component.text.map((content) => ({ type: 10, content })),
      accessory: component.accessory.type === "button"
        ? compileButton(component.accessory, register)
        : compileThumbnail(component.accessory),
    };
    case "media_gallery": return { type: 12, items: component.items.map((item) => ({ media: { url: item.url }, description: item.description, spoiler: item.spoiler })) };
    case "file": return { type: 13, file: { url: component.url }, spoiler: component.spoiler };
    case "separator": return { type: 14, divider: component.divider, spacing: component.spacing === "large" ? 2 : 1 };
    case "container": return {
      type: 17,
      accent_color: component.accentColor,
      spoiler: component.spoiler,
      components: component.components.map((child) => compileMessageComponent(child, register)),
    };
  }
}

function compileActionRow(
  row: DiscordActionRowSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => string,
) {
  return {
    type: 1,
    components: row.components.map((component) => component.type === "button" ? compileButton(component, register) : compileSelect(component, register)),
  };
}

function compileButton(
  button: DiscordButtonSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => string,
) {
  const common = { type: 2, label: button.label, emoji: button.emoji, disabled: button.disabled };
  if (button.style === "link") return { ...common, style: 5, url: button.url };
  if (button.style === "premium") return { type: 2, style: 6, sku_id: button.skuId, disabled: button.disabled };
  const style = { primary: 1, secondary: 2, success: 3, danger: 4 }[button.style];
  const stored: DiscordStoredComponentAction = button.action.type === "modal"
    ? { type: "modal", prompt: button.action.prompt, modal: button.action.modal }
    : { type: "continue", prompt: button.action.prompt };
  return { ...common, style, custom_id: register(stored, button.action.singleUse) };
}

function compileSelect(
  select: DiscordSelectSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => string,
) {
  const type = { string_select: 3, user_select: 5, role_select: 6, mentionable_select: 7, channel_select: 8 }[select.type];
  const base: any = {
    type,
    custom_id: register({ type: "select", prompt: select.prompt }, select.singleUse),
    placeholder: select.placeholder,
    min_values: select.minValues,
    max_values: select.maxValues,
    disabled: select.disabled,
  };
  if (select.type === "string_select") base.options = select.options;
  if (select.type === "channel_select") base.channel_types = select.channelTypes;
  if (select.type !== "string_select" && select.defaultValues) base.default_values = select.defaultValues;
  return base;
}

function compileThumbnail(thumbnail: { url: string; description?: string; spoiler?: boolean }) {
  return { type: 11, media: { url: thumbnail.url }, description: thumbnail.description, spoiler: thumbnail.spoiler };
}

function compileModalField(field: DiscordModalFieldSpec): any {
  if (field.type === "text") return { type: 10, content: field.content };
  const label = (component: any) => ({ type: 18, label: field.label, description: field.description, component });
  switch (field.type) {
    case "text_input": return label({ type: 4, custom_id: field.key, style: field.style === "paragraph" ? 2 : 1, placeholder: field.placeholder, value: field.value, required: field.required, min_length: field.minLength, max_length: field.maxLength });
    case "string_select": return label({ type: 3, custom_id: field.key, options: field.options, placeholder: field.placeholder, required: field.required, min_values: field.minValues, max_values: field.maxValues });
    case "user_select": return label({ type: 5, custom_id: field.key, placeholder: field.placeholder, required: field.required, min_values: field.minValues, max_values: field.maxValues, default_values: field.defaultValues });
    case "role_select": return label({ type: 6, custom_id: field.key, placeholder: field.placeholder, required: field.required, min_values: field.minValues, max_values: field.maxValues, default_values: field.defaultValues });
    case "mentionable_select": return label({ type: 7, custom_id: field.key, placeholder: field.placeholder, required: field.required, min_values: field.minValues, max_values: field.maxValues, default_values: field.defaultValues });
    case "channel_select": return label({ type: 8, custom_id: field.key, placeholder: field.placeholder, required: field.required, min_values: field.minValues, max_values: field.maxValues, channel_types: field.channelTypes, default_values: field.defaultValues });
    case "file_upload": return label({ type: 19, custom_id: field.key, required: field.required, min_values: field.minValues, max_values: field.maxValues });
    case "radio_group": return label({ type: 21, custom_id: field.key, required: field.required, options: field.options });
    case "checkbox_group": return label({ type: 22, custom_id: field.key, required: field.required, min_values: field.minValues, max_values: field.maxValues, options: field.options });
    case "checkbox": return label({ type: 23, custom_id: field.key, default: field.default });
  }
}

export function discordComponentToken(customId: string): { token: string; kind: "action" | "modal"; submission: boolean } | null {
  const match = /^ai:v1:([am]):([A-Za-z0-9_-]{20,32})(:submit)?$/.exec(customId);
  return match ? { token: match[2]!, kind: match[1] === "m" ? "modal" : "action", submission: Boolean(match[3]) } : null;
}
