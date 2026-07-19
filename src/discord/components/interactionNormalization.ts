import { ComponentType, type Attachment, type Message, type MessageComponentInteraction, type ModalData, type ModalSubmitInteraction } from "discord.js";
import type { DiscordAttachmentContext } from "../../tools/types.js";

export type DiscordInteractionComponentType =
  | "button"
  | "string_select"
  | "user_select"
  | "role_select"
  | "mentionable_select"
  | "channel_select"
  | "text_input"
  | "file_upload"
  | "radio_group"
  | "checkbox_group"
  | "checkbox"
  | "modal_submit";

export type DiscordInteractionField =
  | { key: string; type: "text_input" | "radio_group"; value: string | null }
  | { key: string; type: "checkbox"; value: boolean }
  | { key: string; type: "string_select" | "user_select" | "role_select" | "mentionable_select" | "channel_select" | "checkbox_group"; values: string[] }
  | { key: string; type: "file_upload"; files: Array<{ id: string; name: string | null; sizeBytes: number | null; contentType: string | null }> };

export type DiscordInteractionSubmission = {
  schemaVersion: 1;
  messageId: string;
  component: {
    type: DiscordInteractionComponentType;
    values?: string[];
  };
  fields?: DiscordInteractionField[];
};

export function normalizeMessageComponentInteraction(interaction: MessageComponentInteraction): DiscordInteractionSubmission {
  const values = "values" in interaction && Array.isArray(interaction.values) ? [...interaction.values] : undefined;
  return {
    schemaVersion: 1,
    messageId: interaction.message.id,
    component: {
      type: componentTypeName(interaction.componentType),
      ...(values ? { values } : {}),
    },
  };
}

export function normalizeModalSubmission(interaction: ModalSubmitInteraction & { message: Message }): {
  submission: DiscordInteractionSubmission;
  attachments: DiscordAttachmentContext[];
} {
  const fields: DiscordInteractionField[] = [];
  const attachments: DiscordAttachmentContext[] = [];
  for (const [key, component] of interaction.fields.fields) {
    fields.push(normalizeModalField(key, component, attachments));
  }
  return {
    submission: {
      schemaVersion: 1,
      messageId: interaction.message.id,
      component: { type: "modal_submit" },
      fields,
    },
    attachments,
  };
}

function normalizeModalField(
  key: string,
  component: ModalData,
  attachments: DiscordAttachmentContext[],
): DiscordInteractionField {
  switch (component.type) {
    case ComponentType.TextInput:
      return { key, type: "text_input", value: component.value };
    case ComponentType.StringSelect:
      return { key, type: "string_select", values: [...component.values] };
    case ComponentType.UserSelect:
      return { key, type: "user_select", values: [...component.values] };
    case ComponentType.RoleSelect:
      return { key, type: "role_select", values: [...component.values] };
    case ComponentType.MentionableSelect:
      return { key, type: "mentionable_select", values: [...component.values] };
    case ComponentType.ChannelSelect:
      return { key, type: "channel_select", values: [...component.values] };
    case ComponentType.FileUpload: {
      const files = [...component.attachments.values()].map(attachmentSummary);
      attachments.push(...[...component.attachments.values()].map(attachmentContext));
      return { key, type: "file_upload", files };
    }
    case ComponentType.RadioGroup:
      return { key, type: "radio_group", value: component.value };
    case ComponentType.CheckboxGroup:
      return { key, type: "checkbox_group", values: [...component.values] };
    case ComponentType.Checkbox:
      return { key, type: "checkbox", value: component.value };
  }
}

function componentTypeName(type: ComponentType): DiscordInteractionComponentType {
  switch (type) {
    case ComponentType.Button: return "button";
    case ComponentType.StringSelect: return "string_select";
    case ComponentType.UserSelect: return "user_select";
    case ComponentType.RoleSelect: return "role_select";
    case ComponentType.MentionableSelect: return "mentionable_select";
    case ComponentType.ChannelSelect: return "channel_select";
    case ComponentType.TextInput: return "text_input";
    case ComponentType.FileUpload: return "file_upload";
    case ComponentType.RadioGroup: return "radio_group";
    case ComponentType.CheckboxGroup: return "checkbox_group";
    case ComponentType.Checkbox: return "checkbox";
    default: throw new Error(`Unsupported Discord interaction component type: ${type}`);
  }
}

function attachmentContext(attachment: Attachment): DiscordAttachmentContext {
  return {
    id: attachment.id,
    url: attachment.url,
    proxyUrl: attachment.proxyURL,
    filename: attachment.name,
    contentType: attachment.contentType,
    sizeBytes: attachment.size,
    width: attachment.width,
    height: attachment.height,
    description: attachment.description,
  };
}

function attachmentSummary(attachment: Attachment) {
  return {
    id: attachment.id,
    name: attachment.name ?? null,
    sizeBytes: attachment.size ?? null,
    contentType: attachment.contentType ?? null,
  };
}
