export type DiscordComponentAudience = "requester" | "channel";

export type DiscordButtonStyle = "primary" | "secondary" | "success" | "danger";

export type DiscordContinueAction = {
  type: "continue";
  prompt: string;
  singleUse?: boolean;
};

export type DiscordModalAction = {
  type: "modal";
  prompt: string;
  modal: DiscordModalSpec;
  singleUse?: boolean;
};

export type DiscordButtonSpec = {
  type: "button";
  label?: string;
  emoji?: { id?: string; name?: string; animated?: boolean };
  disabled?: boolean;
} & (
  | { style: DiscordButtonStyle; action: DiscordContinueAction | DiscordModalAction }
  | { style: "link"; url: string }
  | { style: "premium"; skuId: string }
);

export type DiscordSelectOptionSpec = {
  label: string;
  value: string;
  description?: string;
  emoji?: { id?: string; name?: string; animated?: boolean };
  default?: boolean;
};

type DiscordSelectBase = {
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
  prompt: string;
  singleUse?: boolean;
};

export type DiscordSelectSpec =
  | (DiscordSelectBase & { type: "string_select"; options: DiscordSelectOptionSpec[] })
  | (DiscordSelectBase & { type: "user_select"; defaultValues?: Array<{ id: string; type: "user" }> })
  | (DiscordSelectBase & { type: "role_select"; defaultValues?: Array<{ id: string; type: "role" }> })
  | (DiscordSelectBase & { type: "mentionable_select"; defaultValues?: Array<{ id: string; type: "user" | "role" }> })
  | (DiscordSelectBase & { type: "channel_select"; channelTypes?: number[]; defaultValues?: Array<{ id: string; type: "channel" }> });

export type DiscordTextDisplaySpec = { type: "text"; content: string };
export type DiscordThumbnailSpec = { type: "thumbnail"; url: string; description?: string; spoiler?: boolean };
export type DiscordMediaGallerySpec = {
  type: "media_gallery";
  items: Array<{ url: string; description?: string; spoiler?: boolean }>;
};
export type DiscordFileDisplaySpec = { type: "file"; url: string; spoiler?: boolean };
export type DiscordSeparatorSpec = { type: "separator"; divider?: boolean; spacing?: "small" | "large" };
export type DiscordActionRowSpec = { type: "action_row"; components: Array<DiscordButtonSpec | DiscordSelectSpec> };
export type DiscordSectionSpec = {
  type: "section";
  text: string[];
  accessory: DiscordButtonSpec | DiscordThumbnailSpec;
};

export type DiscordContainerChildSpec =
  | DiscordActionRowSpec
  | DiscordFileDisplaySpec
  | DiscordMediaGallerySpec
  | DiscordSectionSpec
  | DiscordSeparatorSpec
  | DiscordTextDisplaySpec;

export type DiscordContainerSpec = {
  type: "container";
  accentColor?: number;
  spoiler?: boolean;
  components: DiscordContainerChildSpec[];
};

export type DiscordMessageComponentSpec =
  | DiscordActionRowSpec
  | DiscordContainerSpec
  | DiscordFileDisplaySpec
  | DiscordMediaGallerySpec
  | DiscordSectionSpec
  | DiscordSeparatorSpec
  | DiscordTextDisplaySpec;

export type DiscordModalFieldSpec =
  | { type: "text"; content: string }
  | {
      type: "text_input";
      key: string;
      label: string;
      description?: string;
      style?: "short" | "paragraph";
      placeholder?: string;
      value?: string;
      required?: boolean;
      minLength?: number;
      maxLength?: number;
    }
  | ({ key: string; label: string; description?: string; required?: boolean } & Omit<Extract<DiscordSelectSpec, { type: "string_select" }>, "prompt" | "singleUse" | "disabled" | "minValues" | "maxValues"> & { minValues?: number; maxValues?: number })
  | ({ key: string; label: string; description?: string; required?: boolean } & Omit<Extract<DiscordSelectSpec, { type: "user_select" | "role_select" | "mentionable_select" | "channel_select" }>, "prompt" | "singleUse" | "disabled" | "minValues" | "maxValues"> & { minValues?: number; maxValues?: number; channelTypes?: number[] })
  | { type: "file_upload"; key: string; label: string; description?: string; required?: boolean; minValues?: number; maxValues?: number }
  | { type: "radio_group"; key: string; label: string; description?: string; required?: boolean; options: Array<{ label: string; value: string; description?: string; default?: boolean }> }
  | { type: "checkbox_group"; key: string; label: string; description?: string; required?: boolean; minValues?: number; maxValues?: number; options: Array<{ label: string; value: string; description?: string; default?: boolean }> }
  | { type: "checkbox"; key: string; label: string; description?: string; required?: boolean; default?: boolean };

export type DiscordModalSpec = {
  title: string;
  fields: DiscordModalFieldSpec[];
};

export type DiscordPresentation = {
  version: 1;
  audience: DiscordComponentAudience;
  expiresInMinutes?: number;
  components: DiscordMessageComponentSpec[];
};

export type DiscordStoredComponentAction = {
  type: "continue" | "select" | "modal";
  prompt: string;
  modal?: DiscordModalSpec;
};

export type DiscordComponentSubmission = {
  customId: string;
  values?: string[];
  fields?: Record<string, unknown>;
};
