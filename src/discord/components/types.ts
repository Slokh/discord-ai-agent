export type {
  DiscordActionRowSpec,
  DiscordButtonSpec,
  DiscordButtonStyle,
  DiscordComponentAudience,
  DiscordContainerChildSpec,
  DiscordContainerSpec,
  DiscordContinueAction,
  DiscordFileDisplaySpec,
  DiscordMediaGallerySpec,
  DiscordMessageComponentSpec,
  DiscordModalAction,
  DiscordModalFieldSpec,
  DiscordModalSpec,
  DiscordPresentation,
  DiscordSectionSpec,
  DiscordSelectOptionSpec,
  DiscordSelectSpec,
  DiscordSeparatorSpec,
  DiscordStoredComponentAction,
  DiscordTextDisplaySpec,
  DiscordThumbnailSpec,
} from "./validation.js";

export type DiscordComponentSubmission = {
  customId: string;
  values?: string[];
  fields?: Record<string, unknown>;
};
