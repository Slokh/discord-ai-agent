import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const discordContextFileToolContracts = [
  defineTool({
    name: "getRecentDiscordMessages",
    category: "discord",
    toolClass: "retrieval",
    examples: ["@ai what just happened in here?"],
    description: "Get recent indexed messages from the current channel or specified visible channels.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional visible channel/thread IDs. Defaults to the current channel."
        },
        authorIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord user IDs to restrict messages to."
        },
        limit: {
          type: "number",
          description: "Maximum messages. Defaults to 25."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getDiscordMessageContext",
    category: "discord",
    toolClass: "retrieval",
    examples: ["@ai show the context around this message link"],
    description:
      "Get an indexed Discord message plus nearby messages from the same channel using a specific Discord message link or message ID. Use for exact-message context, replies, or surrounding conversation. Do not use this to analyze broad search results; searchDiscordHistory evidence already includes message URLs.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        messageIdOrUrl: {
          type: "string",
          description: "Discord message ID or https://discord.com/channels/.../.../... link."
        },
        before: {
          type: "number",
          description: "Messages before the target. Defaults to 5."
        },
        after: {
          type: "number",
          description: "Messages after the target. Defaults to 5."
        }
      },
      required: ["messageIdOrUrl"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "listDiscordBugMarkers",
    description:
      "List the current requester's active Discord bug inbox: messages they personally reacted to with the Unicode 🐛 emoji. Use when the user asks about bugs/issues/messages they marked, flagged, or reacted to, especially before asking inspectAgentLogs or runCodingAgent to diagnose or fix them. Results are requester-scoped and permission-filtered, and include the marked message, its link, and the original/replied-to prompt when available. Never substitute aggregate reaction counts or another user's markers.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    category: "discord",
    toolClass: "retrieval",
    outputContract: ["requester-scoped active marker count", "marked message excerpt and link", "original/replied-to prompt excerpt and link when available", "permission and removal guidance"],
    examples: ["@ai show the bugs I marked with 🐛", "@ai fix everything in my bug inbox"],
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum active markers to return. Defaults to 20 and is capped at 25."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "searchDiscordAttachments",
    category: "discord",
    toolClass: "retrieval",
    examples: ["@ai find the image of nachos"],
    description:
      "Search indexed Discord attachments by filename, content type, surrounding message text, author, or channel. Returns attachment URLs and message links. For understanding what is in an image, call inspectDiscordImages after finding the relevant image URL.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Filename, media type, or surrounding message text to search."
        },
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional visible channel/thread IDs."
        },
        authorIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord user IDs."
        },
        contentType: {
          type: "string",
          description: "Optional MIME type prefix, such as image/, video/, audio/, or application/pdf."
        },
        limit: {
          type: "number",
          description: "Maximum attachments. Defaults to 10."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "inspectDiscordFile",
    description:
      "Download and inspect permission-visible Discord file attachments from the current request, reply chain, or an explicit Discord message link/ID. Use this for requests to read, open, parse, identify, summarize, compare, inspect, or transcribe files and media. It fetches fresh Discord CDN URLs, applies strict aggregate download/extraction limits, detects real formats, transcribes common audio/video attachments, and deduplicates identical extracted content across a bounded batch. Supports text/code/config/JSON/CSV/XML, safe ZIP listings, DOCX/PPTX/XLSX text, audio/video transcription, image identification, generic binary metadata/strings, iRacing .sto opaque-container metadata plus structured notes, and exact iRacing setup values from simulator Garage HTML exports or SDK .ibt telemetry containing CarSetup data. Multiple files are inspected together by default when safely bounded; use batchMode=list or attachmentIdOrName to narrow them. Never claim Discord files or media are inaccessible before trying this tool; if none is attached, ask the user to attach it or reply to it.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    category: "discord",
    toolClass: "retrieval",
    outputContract: [
      "permission-checked attachment identity and source message",
      "detected file type, parser, size, and SHA-256",
      "bounded extracted content labeled as untrusted data",
      "bounded audio/video transcript labeled as untrusted data when media is supplied",
      "explicit parser limitations or safe failure reason"
    ],
    examples: [
      "@ai read the file I replied to",
      "@ai inspect the .sto file in this message",
      "@ai analyze the loaded setup in this iRacing .ibt telemetry file",
      "@ai summarize the attached DOCX",
      "@ai transcribe the video I replied to"
    ],
    permissionRequirements: ["requester_visible_discord_channels"],
    auditEvents: ["tool_audit_logs", "discord.file.fetched", "discord.file.inspected", "discord.file.transcribed"],
    parameters: {
      type: "object",
      properties: {
        messageIdOrUrl: {
          type: "string",
          description: "Optional Discord message ID or message URL containing the file. Omit to use current/replied attachments."
        },
        attachmentIdOrName: {
          type: "string",
          description: "Attachment ID or filename to select when the message contains multiple files."
        },
        question: {
          type: "string",
          description: "What the user wants to learn from the file; carried into the inspection evidence."
        },
        useContextFiles: {
          type: "boolean",
          description: "Use files from the current request or Discord reply chain when messageIdOrUrl is omitted. Defaults to true."
        },
        batchMode: {
          type: "string",
          enum: ["inspect", "list"],
          description: "For multiple matches, inspect a safely bounded batch (default) or only list candidates."
        }
      },
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
