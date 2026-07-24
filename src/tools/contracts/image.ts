import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const imageToolContracts = [
  defineTool({
    name: "inspectDiscordImages",
    category: "discord",
    toolClass: "image",
    examples: ["@ai what is in this screenshot?"],
    description:
      "Use a vision model to inspect images from the current Discord request, the replied-to message chain, explicit image URLs, or a Discord message link/ID. Use this when the user asks what is shown in an attached/replied image, screenshot, meme, chart, photo, or visual Discord attachment. Do not use it for text-only history questions.",
    userVisible: true,
    mutates: false,
    group: "image",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The visual question to answer. Defaults to a concise description request."
        },
        imageUrls: {
          type: "array",
          items: { type: "string" },
          description: "Optional direct image URLs, usually from searchDiscordAttachments."
        },
        messageIdOrUrl: {
          type: "string",
          description: "Optional Discord message ID or message URL whose visible image attachments should be inspected."
        },
        useContextImages: {
          type: "boolean",
          description: "Whether to include images attached to the current request or replied-to chain. Defaults to true."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getDiscordUserAvatar",
    examples: ["@ai enhance my profile picture"],
    description:
      "Resolve a visible Discord user by username, display name, mention, or user ID and return their avatar image URL(s) from Discord's CDN. Use this when the user asks to enhance, inspect, describe, or zoom into their own or someone else's profile picture/avatar/pfp. After this tool returns an avatar URL, call inspectDiscordImages with that URL as an imageUrls entry so the vision model can describe or enhance it. Works for any visible user in the server; resolution prefers an exact user ID or mention, then indexed username/display-name matches.",
    userVisible: true,
    mutates: false,
    group: "image",
    category: "discord",
    toolClass: "resolver",
    outputContract: ["resolved user ID and display name", "avatar image URL", "default avatar note when no custom avatar", "match count or ambiguity notes"],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Discord username, display name, @mention, or user ID whose avatar should be fetched. Use the requester's own ID/mention for my/me avatar requests."
        },
        limit: {
          type: "number",
          description: "Maximum matching users to return avatar URLs for when the query is ambiguous. Defaults to 1 and is capped at 5."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "generateImage",
    category: "generation",
    toolClass: "generation",
    examples: ["@ai make an image of a wizard eating nachos"],
    description:
      "Generate an image, or create an edited/modified version using reference images from the current Discord request, reply context, or explicit URLs. Use this for explicit make/draw/generate/regenerate requests and edits like 'make this into...', 'modify this', or 'use the attached image as a reference'. When the requested image must visibly contain exact words, names, labels, punctuation, or numbers, put every verbatim string in requiredText so the result is visually validated and corrected once before delivery. Do not call it for diagnosis-only questions such as why an image has a background or what format it uses unless the user also asks to change or regenerate the image. For emojis, stickers, cutouts, or background removal, request background=transparent and outputFormat=png; the tool also infers those settings from an explicit transparent/emoji/sticker prompt and reports the actual returned format and alpha status.",
    userVisible: true,
    mutates: false,
    group: "image",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The image generation or edit prompt."
        },
        requiredText: {
          type: "array",
          items: { type: "string" },
          description:
            "Every exact string that must be visibly rendered in the image, copied verbatim from the user's request or reply context. Set this for signs, labels, titles, names, scores, numbers, and quoted wording."
        },
        referenceImageUrls: {
          type: "array",
          items: { type: "string" },
          description: "Optional image URLs to use as references, usually from searchDiscordAttachments or inspectDiscordImages context."
        },
        useContextImages: {
          type: "boolean",
          description: "Whether to include images attached to the current request or replied-to chain as references. Defaults to true when context images exist."
        },
        outputFormat: {
          type: "string",
          enum: ["png", "jpeg", "webp"],
          description: "Requested image file format. Use png with a transparent background."
        },
        background: {
          type: "string",
          enum: ["auto", "transparent", "opaque"],
          description: "Requested background treatment. Use transparent for emojis, stickers, cutouts, and explicit background removal."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
