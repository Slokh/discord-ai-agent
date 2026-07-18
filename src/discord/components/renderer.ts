import { randomBytes } from "node:crypto";
import { MessageFlags, ModalBuilder, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
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
  registrations: DiscordActionRegistration[];
};

export async function prepareDiscordPresentation(input: {
  presentation: DiscordPresentation;
  content: string;
  footer?: string | null;
  fileNames?: string[];
  register: (input: { token: string; action: DiscordStoredComponentAction; singleUse: boolean }) => Promise<void>;
}): Promise<PreparedDiscordPresentation> {
  const registrations: DiscordActionRegistration[] = [];
  const compileInteractive = async (action: DiscordStoredComponentAction, singleUse = false) => {
    const token = randomBytes(18).toString("base64url");
    const customId = `ai:v1:${token}`;
    await input.register({ token, action, singleUse });
    registrations.push({ token, customId, action, singleUse });
    return customId;
  };
  const components: any[] = [];
  if (input.content.trim()) components.push({ type: 10, content: input.content.trim() });
  for (const component of input.presentation.components) {
    components.push(await compileMessageComponent(component, compileInteractive));
  }
  const displayedFiles = new Set(collectDisplayedAttachmentNames(input.presentation.components));
  for (const name of input.fileNames ?? []) {
    if (!displayedFiles.has(name)) components.push({ type: 13, file: { url: `attachment://${name}` } });
  }
  if (input.footer?.trim()) components.push({ type: 10, content: input.footer.trim() });
  const componentCount = countCompiledComponents(components);
  if (componentCount > 40) throw new Error(`Discord Components V2 allows at most 40 total components; compiled response has ${componentCount}.`);
  return {
    payload: {
      content: null,
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: components as any,
      allowedMentions: { parse: [], repliedUser: false },
    },
    registrations,
  };
}

function countCompiledComponents(components: any[]): number {
  return components.reduce((total, component) => {
    const nested = Array.isArray(component.components) ? countCompiledComponents(component.components) : 0;
    const accessory = component.accessory ? 1 : 0;
    return total + 1 + nested + accessory;
  }, 0);
}

function collectDisplayedAttachmentNames(components: DiscordMessageComponentSpec[]): string[] {
  const names: string[] = [];
  const visit = (component: DiscordMessageComponentSpec | DiscordContainerChildSpec) => {
    if (component.type === "file" && component.url.startsWith("attachment://")) names.push(component.url.slice("attachment://".length));
    if (component.type === "container") component.components.forEach(visit);
  };
  components.forEach(visit);
  return names;
}

export function buildDiscordModal(customId: string, modal: DiscordModalSpec): ModalBuilder {
  return ModalBuilder.from({
    custom_id: `${customId}:modal`,
    title: modal.title,
    components: modal.fields.map(compileModalField),
  } as any);
}

async function compileMessageComponent(
  component: DiscordMessageComponentSpec | DiscordContainerChildSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => Promise<string>,
): Promise<any> {
  switch (component.type) {
    case "text": return { type: 10, content: component.content };
    case "action_row": return compileActionRow(component, register);
    case "section": return {
      type: 9,
      components: component.text.map((content) => ({ type: 10, content })),
      accessory: component.accessory.type === "button"
        ? await compileButton(component.accessory, register)
        : compileThumbnail(component.accessory),
    };
    case "media_gallery": return { type: 12, items: component.items.map((item) => ({ media: { url: item.url }, description: item.description, spoiler: item.spoiler })) };
    case "file": return { type: 13, file: { url: component.url }, spoiler: component.spoiler };
    case "separator": return { type: 14, divider: component.divider, spacing: component.spacing === "large" ? 2 : 1 };
    case "container": return {
      type: 17,
      accent_color: component.accentColor,
      spoiler: component.spoiler,
      components: await Promise.all(component.components.map((child) => compileMessageComponent(child, register))),
    };
  }
}

async function compileActionRow(
  row: DiscordActionRowSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => Promise<string>,
) {
  return {
    type: 1,
    components: await Promise.all(row.components.map((component) => component.type === "button" ? compileButton(component, register) : compileSelect(component, register))),
  };
}

async function compileButton(
  button: DiscordButtonSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => Promise<string>,
) {
  const common = { type: 2, label: button.label, emoji: button.emoji, disabled: button.disabled };
  if (button.style === "link") return { ...common, style: 5, url: button.url };
  if (button.style === "premium") return { type: 2, style: 6, sku_id: button.skuId, disabled: button.disabled };
  const style = { primary: 1, secondary: 2, success: 3, danger: 4 }[button.style];
  const stored: DiscordStoredComponentAction = button.action.type === "modal"
    ? { type: "modal", prompt: button.action.prompt, modal: button.action.modal }
    : { type: "continue", prompt: button.action.prompt };
  return { ...common, style, custom_id: await register(stored, button.action.singleUse) };
}

async function compileSelect(
  select: DiscordSelectSpec,
  register: (action: DiscordStoredComponentAction, singleUse?: boolean) => Promise<string>,
) {
  const type = { string_select: 3, user_select: 5, role_select: 6, mentionable_select: 7, channel_select: 8 }[select.type];
  const base: any = {
    type,
    custom_id: await register({ type: "select", prompt: select.prompt }, select.singleUse),
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
    case "channel_select": return label({ type: 8, custom_id: field.key, placeholder: field.placeholder, required: field.required, min_values: field.minValues, max_values: field.maxValues, channel_types: (field as any).channelTypes, default_values: field.defaultValues });
    case "file_upload": return label({ type: 19, custom_id: field.key, required: field.required, min_values: field.minValues, max_values: field.maxValues });
    case "radio_group": return label({ type: 21, custom_id: field.key, required: field.required, options: field.options });
    case "checkbox_group": return label({ type: 22, custom_id: field.key, required: field.required, min_values: field.minValues, max_values: field.maxValues, options: field.options });
    case "checkbox": return label({ type: 23, custom_id: field.key, required: field.required, default: field.default });
  }
}

export function discordComponentToken(customId: string): { token: string; modal: boolean } | null {
  const match = /^ai:v1:([A-Za-z0-9_-]{20,32})(:modal)?$/.exec(customId);
  return match ? { token: match[1]!, modal: Boolean(match[2]) } : null;
}
