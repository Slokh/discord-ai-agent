import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";
import { discordPresentationToolParameters } from "../../discord/components/validation.js";

export const presentationToolContracts = [
  defineTool({
    name: "composeDiscordResponse",
    description:
      "Design an optional Discord Components V2 presentation for the final reply. Use only when native layout or interaction materially improves the answer: clear next-action buttons, bounded choices, a form, media gallery, attached-file display, or a genuinely scannable card. Do not decorate simple answers. Final response text is automatically rendered above these components. Use this semantic schema exactly: pass components as an array, use named component types and styles, and describe interactive behavior with action or prompt. Never send numeric Discord API types/styles, custom_id, callback code, or a JSON-encoded components string; code generates protocol IDs and enforces authority. Supports all current Discord message components: action_row, button, string_select, user_select, role_select, mentionable_select, channel_select, section, text, thumbnail, media_gallery, file, separator, and container. Buttons may continue the conversation, open a modal, navigate to a link, or use a configured premium SKU. Modal fields support text, text_input, all select types, file_upload, radio_group, checkbox_group, and checkbox. Generic component actions never authorize money, wager, admin, deletion, or other mutations.",
    userVisible: true,
    mutates: false,
    group: "presentation",
    category: "discord",
    toolClass: "generation",
    outputContract: ["validated Components V2 presentation", "requester or channel audience", "durable bounded interaction actions"],
    examples: ["Show results as a card with source links", "Let me choose one of these channels", "Ask me for the remaining event details"],
    argumentExamples: [{
      audience: "requester",
      components: [{
        type: "action_row",
        components: [{
          type: "button",
          label: "Show details",
          style: "primary",
          action: { type: "continue", prompt: "Show me the detailed explanation." },
        }],
      }],
    }],
    parameters: discordPresentationToolParameters,
  }),
] satisfies ToolRegistryEntry[];
