import type { FunctionToolDefinition, OpenRouterServerToolDefinition, ToolDefinition } from "../models/openrouter.js";

export type ToolName =
  | "listTools"
  | "requestAdditionalTools"
  | "findDiscordUsers"
  | "findDiscordChannels"
  | "searchDiscordHistory"
  | "getRecentAgentMemory"
  | "getAgentMemoryStats"
  | "getRecentDiscordMessages"
  | "getDiscordMessageContext"
  | "searchDiscordAttachments"
  | "inspectDiscordFile"
  | "inspectDiscordImages"
  | "getDiscordUserAvatar"
  | "getDiscordStats"
  | "getDiscordChannelTopics"
  | "summarizeDiscordHistory"
  | "summarizeDiscordThread"
  | "generateImage"
  | "readGeneratedFile"
  | "queryGeneratedCsv"
  | "queryGeneratedTable"
  | "createSkillDraft"
  | "runCodingAgent"
  | "getAgentTaskStatus"
  | "listAgentTasks"
  | "retryAgentTask"
  | "cancelAgentTask"
  | "getDeploymentStatus"
  | "getSpendSummary"
  | "inspectAgentLogs"
  | "undoConversationTurns"
  | "reportStatus"
  | "getWalletBalance"
  | "listWalletBalances"
  | "transferWalletFunds"
  | "requestStarterFunds"
  | "adminTransferWalletFunds"
  | "reconcileWalletTransfers"
  | "getSpotifyPlaylistTracks"
  | "getSpotifyAlbumTracks"
  | "getSpotifyArtistDiscography"
  | "getSpotifyPlaylistStats"
  | "compareSpotifyPlaylists"
  | "searchSpotify"
  | "getSpotifyItem"
  | "createDiscordPoll"
  | "updateBotAvatar"
  | "setUserTurnLimit"
  | "drawRandom"
  | "awaitRandomWagerAction"
  | "settleRandomWager"
  | "revealRandomness";

export type ToolGroup =
  | "core"
  | "discord-retrieval"
  | "generated-data"
  | "discord-action"
  | "image"
  | "spotify"
  | "codegen"
  | "ops"
  | "external";

export const TOOL_GROUPS: ToolGroup[] = [
  "core",
  "discord-retrieval",
  "generated-data",
  "discord-action",
  "image",
  "spotify",
  "codegen",
  "ops",
  "external"
];

export type ToolClass =
  | "resolver"
  | "retrieval"
  | "memory"
  | "stats"
  | "summary"
  | "image"
  | "generation"
  | "coding"
  | "ops"
  | "external";

export type ToolRegistryEntry = {
  name: ToolName;
  description: string;
  userVisible: boolean;
  mutates: boolean;
  category?: "discord" | "generation" | "memory" | "ops" | "coding" | "external";
  group: ToolGroup;
  toolClass?: ToolClass;
  outputContract?: string[];
  examples?: string[];
  permissionRequirements?: string[];
  auditEvents?: string[];
  parameters: FunctionToolDefinition["function"]["parameters"];
};

export type ToolContract = {
  name: ToolName;
  description: string;
  category: NonNullable<ToolRegistryEntry["category"]>;
  toolClass: ToolClass;
  mutates: boolean;
  userVisible: boolean;
  parameters: FunctionToolDefinition["function"]["parameters"];
  whenToUse: string;
  outputContract: string[];
  permissionRequirements: string[];
  auditEvents: string[];
  examples: string[];
};

export const toolRegistry: ToolRegistryEntry[] = [
  {
    name: "listTools",
    description: "List Discord AI Agent's available local and hosted tools.",
    userVisible: true,
    mutates: false,
    group: "core",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },

  {
    name: "requestAdditionalTools",
    description:
      "Escalation valve: request additional tool groups when the current scoped tools are insufficient. Use this instead of guessing when a needed capability is missing.",
    userVisible: false,
    mutates: false,
    group: "core",
    category: "ops",
    toolClass: "ops",
    outputContract: ["requested groups", "newly available tool names", "reason"],
    parameters: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: { type: "string", enum: TOOL_GROUPS },
          description: `Optional tool groups to add; omit to request all groups. Valid groups: ${TOOL_GROUPS.join(", ")}.`
        },
        reason: { type: "string", description: "Why more tools are needed." }
      },
      required: ["reason"],
      additionalProperties: false
    }
  },
  {
    name: "findDiscordUsers",
    description:
      "Intermediate resolver: find Discord users by username, display name, nickname-like text, mention, or ID before filtering history/stats by author. Do not answer from this alone when the user asked what someone said, did, or has been up to; call the relevant history, summary, or stats tool next.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name, username, mention, or Discord user ID to resolve."
        },
        limit: {
          type: "number",
          description: "Maximum matches to return. Defaults to 8."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "findDiscordChannels",
    description:
      "Intermediate resolver: find visible Discord channels, threads, or forums by name, mention, or ID before filtering history/stats by channel. Do not answer from this alone when the user asked what happened in a channel; call the relevant history, summary, topics, or stats tool next.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Channel/thread/forum name, channel mention, or Discord channel ID to resolve."
        },
        limit: {
          type: "number",
          description: "Maximum matches to return. Defaults to 8."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "searchDiscordHistory",
    description:
      "Search permission-filtered indexed Discord history using hybrid keyword and semantic vector retrieval. Use for questions about what people in this Discord server said, sent, remembered, or asked before. Do not use for public web facts unless the user asks what this server said about them. Prefer a short focused search phrase, not the entire user request. Use authorIds/authorQueries for messages written by someone; use aboutUserIds/aboutUserQueries for messages about or mentioning someone. Use structured person/channel filters after findDiscordUsers/findDiscordChannels when names are ambiguous. One or two distinct searches is usually enough before answering. Supports filter syntax like from:name, in:channel, after:YYYY-MM-DD, before:YYYY-MM-DD.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Focused Discord history search phrase. May include from:, in:, after:, before:, since:, or until: filters if the user typed them."
        },
        authorIds: {
          type: "array",
          items: { type: "string" },
          description: "Discord user IDs to restrict the search to."
        },
        authorQueries: {
          type: "array",
          items: { type: "string" },
          description: "Discord names/usernames/aliases to resolve and restrict the search to when exact user IDs are not known."
        },
        aboutUserIds: {
          type: "array",
          items: { type: "string" },
          description: "Discord user IDs that the messages should be about or mention. Use for subject requests like my birthday, people mentioning me, or what was said about Alex."
        },
        aboutUserQueries: {
          type: "array",
          items: { type: "string" },
          description: "Discord names/usernames/aliases to resolve as subject users when exact IDs are not known."
        },
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Discord channel/thread IDs to restrict the search to."
        },
        channelQueries: {
          type: "array",
          items: { type: "string" },
          description: "Discord channel names to resolve and restrict the search to when exact channel IDs are not known."
        },
        dateFrom: {
          type: "string",
          description: "Inclusive UTC date lower bound as YYYY-MM-DD. Set this explicitly for recent/latest/current/time-window requests."
        },
        dateTo: {
          type: "string",
          description: "Inclusive UTC date upper bound as YYYY-MM-DD. Set this explicitly when the user gives an end date or bounded window."
        },
        limit: {
          type: "number",
          description: "Maximum evidence messages to retrieve for the final answer."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "getRecentAgentMemory",
    description:
      "Get recent Discord AI Agent conversation memory from the current channel. Use for questions about what the agent previously said, did, generated, linked, opened, or needs to continue. Do not use for factual claims about server history; use Discord history/stat tools for that.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    category: "memory",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum recent memory rows. Defaults to 12."
        },
        includeToolResults: {
          type: "boolean",
          description: "Whether to include previous local tool results. Defaults to true."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "getAgentMemoryStats",
    description:
      "Count or inspect Discord AI Agent's completed assistant turns in the current channel. Use for questions like how many turns/replies/actions the bot completed, especially since a specific Discord message, message link, or anchor phrase. This queries agent memory and indexed channel messages; do not approximate this with Discord history search.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    category: "memory",
    parameters: {
      type: "object",
      properties: {
        sinceText: {
          type: "string",
          description: "Optional exact or memorable text from an earlier channel message to count after."
        },
        sinceMessageIdOrUrl: {
          type: "string",
          description: "Optional Discord message ID or URL to count after."
        },
        sinceAuthor: {
          type: "string",
          enum: ["requester", "anyone"],
          description: "Whose anchor message to match when sinceText is provided. Use requester for phrases like 'since I said...'; use anyone if the user does not specify who said it."
        },
        limit: {
          type: "number",
          description: "Maximum recent counted assistant turns to include as examples. Defaults to 8."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "getRecentDiscordMessages",
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
  },
  {
    name: "getDiscordMessageContext",
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
  },
  {
    name: "searchDiscordAttachments",
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
  },
  {
    name: "inspectDiscordFile",
    description:
      "Download and inspect permission-visible Discord file attachments from the current request, reply chain, or an explicit Discord message link/ID. Use this for requests to read, open, parse, identify, summarize, compare, or inspect files and documents. It fetches fresh Discord CDN URLs, applies strict aggregate download/extraction limits, detects real formats, and deduplicates identical extracted content across a bounded batch. Supports text/code/config/JSON/CSV/XML, safe ZIP listings, DOCX/PPTX/XLSX text, image identification, generic binary metadata/strings, iRacing .sto opaque-container metadata plus structured notes, and exact iRacing setup values from simulator Garage HTML exports or SDK .ibt telemetry containing CarSetup data. Multiple files are inspected together by default when safely bounded; use batchMode=list or attachmentIdOrName to narrow them. Never claim Discord files are inaccessible before trying this tool.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    category: "discord",
    toolClass: "retrieval",
    outputContract: [
      "permission-checked attachment identity and source message",
      "detected file type, parser, size, and SHA-256",
      "bounded extracted content labeled as untrusted data",
      "explicit parser limitations or safe failure reason"
    ],
    examples: [
      "@ai read the file I replied to",
      "@ai inspect the .sto file in this message",
      "@ai analyze the loaded setup in this iRacing .ibt telemetry file",
      "@ai summarize the attached DOCX"
    ],
    permissionRequirements: ["requester_visible_discord_channels"],
    auditEvents: ["tool_audit_logs", "discord.file.fetched", "discord.file.inspected"],
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
  },
  {
    name: "inspectDiscordImages",
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
  },
  {
    name: "getDiscordUserAvatar",
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
  },
  {
    name: "getDiscordStats",
    description:
      "Compute permission-filtered Discord analytics over indexed visible messages. Use this for counts, rankings, lowest/highest rankings, activity over time, messages by channel/user, normalized messages-per-day comparisons, attachment stats, reaction totals, and active-day summaries.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        authorIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord user IDs to filter to."
        },
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord channel/thread IDs to filter to."
        },
        authorQueries: {
          type: "array",
          items: { type: "string" },
          description: "Optional user names/usernames to resolve and filter to when exact IDs are not known."
        },
        channelQueries: {
          type: "array",
          items: { type: "string" },
          description: "Optional channel names to resolve and filter to when exact IDs are not known."
        },
        dateFrom: {
          type: "string",
          description: "Inclusive UTC date lower bound as YYYY-MM-DD."
        },
        dateTo: {
          type: "string",
          description: "Inclusive UTC date upper bound as YYYY-MM-DD."
        },
        groupBy: {
          type: "string",
          enum: ["overall", "user", "channel", "thread", "message", "day", "week", "month", "year", "hourOfDay", "dayOfWeek"],
          description:
            "Dimension to group the metric by. Use channel for parent-channel rankings with thread/forum-post messages rolled up. Use thread only when the user asks for threads/forum posts separately. Use message with metric=reactions for top/favorite message evidence."
        },
        metric: {
          type: "string",
          enum: ["messages", "attachments", "reactions", "uniqueActiveDays", "messagesPerActiveDay", "messagesPerChannelDay"],
          description:
            "Metric to calculate. Defaults to messages. Use messagesPerChannelDay to normalize channel popularity by days since channel creation. Use messagesPerActiveDay to normalize by days with messages."
        },
        includeBots: {
          type: "boolean",
          description: "Whether to include bot-authored messages. Defaults to false."
        },
        sort: {
          type: "string",
          enum: ["countDesc", "countAsc", "dateAsc", "dateDesc", "labelAsc"],
          description: "Sort order for grouped rows. Use countAsc for least/fewest/lowest and countDesc for most/highest."
        },
        query: {
          type: "string",
          description: "Optional keyword/topic filter over message text before counting."
        },
        attachmentContentType: {
          type: "string",
          description: "Optional MIME prefix for attachment metrics, such as image/, video/, or application/pdf."
        },
        limit: {
          type: "number",
          description: "Maximum grouped rows/top items to return. Defaults to 10."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "getDiscordChannelTopics",
    description:
      "Summarize the main recurring topics, themes, memes, and bits in major Discord channels using sampled indexed messages and stored embeddings. Use this for 'what do people talk about in each channel' rather than exact counts.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord parent channel/thread IDs to restrict topic analysis to."
        },
        channelQueries: {
          type: "array",
          items: { type: "string" },
          description: "Optional channel names to resolve and analyze."
        },
        dateFrom: {
          type: "string",
          description: "Inclusive UTC date lower bound as YYYY-MM-DD."
        },
        dateTo: {
          type: "string",
          description: "Inclusive UTC date upper bound as YYYY-MM-DD."
        },
        channelLimit: {
          type: "number",
          description: "Maximum major channels to analyze. Defaults to 8."
        },
        topicsPerChannel: {
          type: "number",
          description: "Maximum recurring topics to list per channel. Defaults to 3."
        },
        samplesPerChannel: {
          type: "number",
          description: "Maximum sampled messages per channel. Defaults to 90."
        },
        minChannelMessages: {
          type: "number",
          description: "Minimum substantive indexed messages for a channel to be included. Defaults to 100."
        },
        minMessageChars: {
          type: "number",
          description: "Minimum message length to include as topic evidence. Defaults to 12."
        },
        includeBots: {
          type: "boolean",
          description: "Whether to include bot-authored messages. Defaults to false."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "summarizeDiscordHistory",
    description:
      "Summarize representative indexed Discord history over a user, channel, topic, or date window. Use this for broad questions like what a person/channel has been up to, what happened recently, or a recap over time. After resolving a named user/channel, call this rather than answering from resolver output alone. It samples across the window instead of only returning the newest messages.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The user's summary question or focus."
        },
        authorIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord user IDs to summarize."
        },
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord channel/thread IDs to summarize."
        },
        authorQueries: {
          type: "array",
          items: { type: "string" },
          description: "Optional user names/usernames to resolve and summarize when exact IDs are not known."
        },
        aboutUserIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional Discord user IDs that sampled messages should be about or mention."
        },
        aboutUserQueries: {
          type: "array",
          items: { type: "string" },
          description: "Optional names/usernames/aliases to resolve as subject users for about/mention summaries."
        },
        channelQueries: {
          type: "array",
          items: { type: "string" },
          description: "Optional channel names to resolve and summarize when exact IDs are not known."
        },
        dateFrom: {
          type: "string",
          description: "Inclusive UTC date lower bound as YYYY-MM-DD. Set this explicitly for recent/latest/current/time-window summaries."
        },
        dateTo: {
          type: "string",
          description: "Inclusive UTC date upper bound as YYYY-MM-DD."
        },
        sampleLimit: {
          type: "number",
          description: "Representative messages to sample before summarizing. Defaults to 60."
        }
      },
      required: ["question"],
      additionalProperties: false
    }
  },
  {
    name: "summarizeDiscordThread",
    description:
      "Summarize indexed messages from the current channel or thread. With no question, summarize recent chronological context. With a question, use hybrid semantic/keyword/recent evidence from this channel to focus the summary.",
    userVisible: true,
    mutates: false,
    group: "discord-retrieval",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Optional focused question for the summary, such as deployment discussion, decisions, or open issues."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "generateImage",
    description:
      "Generate an image, or create an edited/modified version using reference images from the current Discord request, reply context, or explicit URLs. Use this for make/draw/generate image requests and for edits like 'make this into...', 'modify this', or 'use the attached image as a reference'.",
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
        referenceImageUrls: {
          type: "array",
          items: { type: "string" },
          description: "Optional image URLs to use as references, usually from searchDiscordAttachments or inspectDiscordImages context."
        },
        useContextImages: {
          type: "boolean",
          description: "Whether to include images attached to the current request or replied-to chain as references. Defaults to true when context images exist."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  {
    name: "readGeneratedFile",
    description:
      "Read a bounded text chunk from a file produced by an earlier tool call in the same agent turn. Use this for generated text or CSV files when the user asks to inspect file contents, see examples, or when a small preview is enough. For exact counts, filters, or rankings over CSV files, use queryGeneratedCsv instead of reading the whole file.",
    userVisible: true,
    mutates: false,
    group: "generated-data",
    category: "memory",
    toolClass: "retrieval",
    outputContract: ["generated file metadata", "byte range", "bounded content excerpt", "truncation status"],
    parameters: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description: "Name of the generated file to read. If omitted and exactly one generated file exists, that file is used."
        },
        fileIndex: {
          type: "number",
          description: "1-based index of the generated file to read, useful when multiple generated files exist."
        },
        offsetBytes: {
          type: "number",
          description: "Byte offset to start reading from. Defaults to 0."
        },
        maxBytes: {
          type: "number",
          description: "Maximum bytes to return. Defaults to 4000 and is capped at 20000."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "queryGeneratedCsv",
    description:
      "Run deterministic tabular queries over a CSV file produced by an earlier tool call in the same agent turn. Use this for exact row counts, top values, filters, rankings, and sample rows from generated CSVs instead of asking the model to count or parse raw CSV text. This is generic generated-file infrastructure and is not specific to any provider.",
    userVisible: true,
    mutates: false,
    group: "generated-data",
    category: "memory",
    toolClass: "stats",
    outputContract: ["generated CSV metadata", "filters applied", "row count", "ranked rows or values", "sample rows when requested"],
    parameters: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description: "Name of the generated CSV file to query. If omitted and exactly one generated CSV exists, that file is used."
        },
        fileIndex: {
          type: "number",
          description: "1-based index of the generated file to query."
        },
        operation: {
          type: "string",
          enum: ["profile", "topValues", "filterRows"],
          description: "Query operation. profile returns row/column metadata, topValues ranks values in one column, and filterRows returns matching rows."
        },
        column: {
          type: "string",
          description: "Column to rank for topValues."
        },
        filters: {
          type: "array",
          description: "Optional column filters applied before the operation. Comparisons are exact/string/numeric as appropriate; YYYY-MM-DD dates compare correctly as strings.",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "notEq", "contains", "gt", "gte", "lt", "lte"] },
              value: { type: "string" }
            },
            required: ["column", "op", "value"],
            additionalProperties: false
          }
        },
        selectColumns: {
          type: "array",
          items: { type: "string" },
          description: "Columns to include for filterRows. Defaults to the first columns in the CSV."
        },
        limit: {
          type: "number",
          description: "Maximum rows or ranked values to return. Defaults to 10 and is capped at 100."
        },
        splitValues: {
          type: "boolean",
          description: "For topValues, split each cell before counting. Useful for comma-separated columns like artist lists."
        },
        valueDelimiter: {
          type: "string",
          description: "Delimiter used when splitValues is true. Defaults to comma."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "queryGeneratedTable",
    description:
      "Run deterministic tabular queries over a structured table artifact produced by an earlier tool call in the same agent turn. Use this for exact row counts, top values, filters, rankings, and sample rows from generated tables without reading raw attachment text. This is generic generated-artifact infrastructure and is not specific to any provider.",
    userVisible: true,
    mutates: false,
    group: "generated-data",
    category: "memory",
    toolClass: "stats",
    outputContract: ["generated table metadata", "filters applied", "row count", "ranked rows or values", "sample rows when requested"],
    parameters: {
      type: "object",
      properties: {
        tableName: {
          type: "string",
          description: "Name of the generated table to query. If omitted and exactly one generated table exists, that table is used."
        },
        tableIndex: {
          type: "number",
          description: "1-based index of the generated table to query."
        },
        operation: {
          type: "string",
          enum: ["profile", "topValues", "filterRows"],
          description: "Query operation. profile returns row/column metadata, topValues ranks values in one column, and filterRows returns matching rows."
        },
        column: {
          type: "string",
          description: "Column to rank for topValues."
        },
        filters: {
          type: "array",
          description: "Optional column filters applied before the operation. Comparisons are exact/string/numeric as appropriate; YYYY-MM-DD dates compare correctly as strings.",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "notEq", "contains", "gt", "gte", "lt", "lte"] },
              value: { type: "string" }
            },
            required: ["column", "op", "value"],
            additionalProperties: false
          }
        },
        selectColumns: {
          type: "array",
          items: { type: "string" },
          description: "Columns to include for filterRows. Defaults to the first columns in the table."
        },
        limit: {
          type: "number",
          description: "Maximum rows or ranked values to return. Defaults to 10 and is capped at 100."
        },
        splitValues: {
          type: "boolean",
          description: "For topValues, split each cell before counting. Useful for comma-separated columns like artist lists."
        },
        valueDelimiter: {
          type: "string",
          description: "Delimiter used when splitValues is true. Defaults to comma."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "createSkillDraft",
    description:
      "Create or update a private database-backed Markdown skill. Use only when the user explicitly asks the agent to learn, remember, save, or update durable behavior/knowledge for next time.",
    userVisible: true,
    mutates: true,
    group: "ops",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Short stable kebab-case skill name, such as movie-night, minecraft-server, or house-rules."
        },
        instruction: {
          type: "string",
          description: "The durable instruction the user wants Discord AI Agent to remember."
        }
      },
      required: ["skillName", "instruction"],
      additionalProperties: false
    }
  },
  {
    name: "runCodingAgent",
    description:
      "Start an isolated sandbox task for Discord AI Agent code, repository, GitHub PR, CI, deployment, or self-update work. The bot will update the same Discord reply with progress and the PR link when the task finishes. Use when the user asks the agent to update itself, add, build, implement, change behavior, debug or fix failing CI/checks/tests, inspect a PR/repo failure, or continue work from a previous code-update task. Prefer this over hosted web tools for GitHub, CI, PR, or repository debugging because the sandbox has repo checkout, shell, tests, and gh CLI access.",
    userVisible: true,
    mutates: true,
    group: "codegen",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "The full requested agent update, integration, or repository change to implement. Preserve the user's desired outcome, especially when the wording combines investigation with an action like 'where is X defined, can we change/increase/fix it?'. Do not reduce that to a read-only find/debug request."
        },
        title: {
          type: "string",
          description:
            "Optional concise human PR title in plain English, 3-8 words, without prefixes like Agent Codegen. Name the intended change, not just the investigation. Example: Increase model output token limit."
        },
        targetBranch: {
          type: "string",
          description:
            "Optional existing Git branch to update instead of creating a new branch. Set this when the user asks to fix, continue, or update an existing PR and the branch is known from context."
        },
        targetPullRequestNumber: {
          type: "number",
          description:
            "Optional existing GitHub pull request number to update. Set this when the user references an existing PR, such as PR #120 or a GitHub pull request URL."
        },
        targetPullRequestUrl: {
          type: "string",
          description:
            "Optional existing GitHub pull request URL to update. Set this when the user provides or replies to a PR link."
        }
      },
      required: ["request"],
      additionalProperties: false
    }
  },
  {
    name: "getAgentTaskStatus",
    description:
      "Look up quick status for the current or recent code-update task: progress events, sandbox command output snippets, PR link, and GitHub PR/CI check status when available. Use for read-only status questions like whether an update is done, what PR was opened, or what the latest task ID is. If the user asks to debug, investigate, explain, or fix a GitHub/CI/check/test/repo failure, call runCodingAgent so the sandbox can use gh CLI, logs, repo files, and tests.",
    userVisible: true,
    mutates: false,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Optional task ID. If omitted, returns the latest visible task in this Discord channel."
        },
        limit: {
          type: "number",
          description: "Maximum progress and command events to include. Defaults to 8."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "listAgentTasks",
    description:
      "List recent visible code-update tasks with their statuses. Use when a user asks for task history, queued work, previous PR attempts, or what updates are in progress.",
    userVisible: true,
    mutates: false,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: ["queued", "running", "succeeded", "failed", "no_changes", "cancelled"]
          },
          description: "Optional statuses to filter by."
        },
        limit: {
          type: "number",
          description: "Maximum tasks to return. Defaults to 10."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "retryAgentTask",
    description:
      "Retry a failed, no-change, or cancelled code-update task using the original request. Use when a user asks to retry, rerun, or try again after a code-update task did not complete.",
    userVisible: true,
    mutates: true,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Optional task ID. If omitted, retries the latest retryable visible task in this Discord channel."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "cancelAgentTask",
    description:
      "Cancel an active queued or running code-update task. Use when a user asks to stop, cancel, abort, or kill an in-progress self-update.",
    userVisible: true,
    mutates: true,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Optional task ID. If omitted, cancels the latest active visible task in this Discord channel."
        },
        reason: {
          type: "string",
          description: "Optional user-facing reason for cancellation."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "getDeploymentStatus",
    description:
      "Report the running deployment revision, uptime, database health, active or stale code-update tasks, agent task metrics, and recent tasks. Use after deploys or when users ask whether the deployed bot is healthy or whether codegen is stuck.",
    userVisible: true,
    mutates: false,
    group: "ops",
    category: "ops",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "getSpendSummary",
    description:
      "Report estimated model/tool spend for this Discord guild from tool audit logs. Use when ops users ask how much the bot has spent today or this month, or which tools/users drove spend.",
    userVisible: true,
    mutates: false,
    group: "ops",
    category: "ops",
    outputContract: ["total estimated spend", "top tools by spend", "top users by spend", "period"],
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "month"], description: "Spend period. Defaults to today." },
        limit: { type: "number", description: "Maximum rows per breakdown. Defaults to 10." }
      },
      additionalProperties: false
    }
  },
  {
    name: "undoConversationTurns",
    description:
      "Undo the agent's most recent reply turns in the current Discord channel by removing them from persistent memory and, when possible, deleting the bot reply messages. Use when the user asks to undo, forget, delete, or remove the agent's previous response.",
    userVisible: true,
    mutates: true,
    group: "discord-action",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of recent agent turns to undo. Defaults to 1 and is capped by the tool."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "inspectAgentLogs",
    description:
      "Inspect Discord AI Agent's own normalized run diagnostics, model rounds, prompt composition, critical path, trace events, task events, terminal command events, and tool audit logs for debugging slow, failed, hung, or confusing bot behavior. When the user is replying to the run or bot response, omit traceId to resolve the reply chain automatically. Use detail=model_io only when the user explicitly asks to inspect the exact model input, output, or prompt; returned excerpts are permission-filtered, secret-redacted, and bounded.",
    userVisible: true,
    mutates: false,
    group: "ops",
    category: "ops",
    outputContract: [
      "resolved requester-visible run reference",
      "model-round, prompt-composition, and critical-path diagnosis",
      "bounded secret-redacted model input/output when explicitly requested",
      "recent trace, task, command, and tool evidence",
    ],
    permissionRequirements: ["owner_or_authorized_debugger", "requester_visible_discord_channels", "tool_audit_log"],
    auditEvents: ["tool_audit_logs", "trace_events"],
    examples: ["@ai why did that last answer fail?", "@ai debug this", "@ai show me the exact prompt you received"],
    parameters: {
      type: "object",
      properties: {
        traceId: {
          type: "string",
          description: "Optional trace ID, run ID, originating Discord message ID, or Discord message URL to inspect."
        },
        limit: {
          type: "number",
          description: "Maximum trace events and tool logs to return. Defaults to 20."
        },
        detail: {
          type: "string",
          enum: ["summary", "model_io"],
          description: "Use summary for normal debugging. Use model_io only for an explicit request to inspect bounded redacted model input/output."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "reportStatus",
    description: "Report local database, crawl, and tool status.",
    userVisible: true,
    mutates: false,
    group: "ops",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "getWalletBalance",
    description:
      "Read a current USD wallet balance. Use owner=requester for 'my/mine' and unqualified balance requests; use owner=bot for 'your/yours', the bot, or the bot treasury. Use owner=user with a resolved userId for another member; owner/ops can always do this, and every member can when WALLET_BALANCES_PUBLIC=true. Another member without a wallet is reported as $0 without creating one. ALWAYS call this instead of answering from memory whenever the user asks about a wallet, balance, bankroll, casino funds, or available money. Existing wallet balances are verified live onchain against USDC.e and presented simply as $ or USD.",
    userVisible: true,
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["verified current USD balance", "public managed-wallet address", "Tempo network", "onchain verification timestamp"],
    examples: ["@ai balance", "@ai what's my bankroll?", "@ai what's your balance?"],
    permissionRequirements: ["configured_wallet_runtime", "requester_scope", "public_balance_directory_or_owner_ops_for_other_users"],
    auditEvents: ["tool_audit_logs", "wallet.provision.*"],
    parameters: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          enum: ["requester", "bot", "user"],
          description: "Whose wallet to read. Defaults to the requester when user wallets are enabled, otherwise the bot. Use bot for your/the bot's balance. user requires userId and public balance visibility or payment-admin permission."
        },
        userId: {
          type: "string",
          description: "Discord user ID or mention when owner=user. Resolve names with findDiscordUsers first."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "listWalletBalances",
    description:
      "List the managed wallet directory for this Discord server. ALWAYS use this for plural or server-wide balance or address requests. Use view=balances for 'every user's balance', view=addresses for wallet-address questions, and view=both only when both were explicitly requested. Balance views include the shared AI treasury plus only member wallets with a verified non-$0 balance; $0, unavailable, and missing member wallets are summarized but omitted. Address-only views include the AI and every existing member wallet without repeating balances or creating wallets. This directory is available to owner/ops, or to every member when WALLET_BALANCES_PUBLIC=true.",
    userVisible: true,
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["requested balances, addresses, or both", "shared AI treasury", "only verified non-$0 rows for balance views", "only existing wallets for address-only views", "compact Markdown table"],
    examples: ["@ai what's the balance of every user in this server?", "@ai can I get their wallet addresses?"],
    permissionRequirements: ["configured_user_wallet_runtime", "live_discord_member_roster", "public_balance_directory_or_owner_ops"],
    auditEvents: ["tool_audit_logs", "wallet.directory.read"],
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["balances", "addresses", "both"],
          description: "Directory fields to return. Use addresses for address-only questions to avoid repeating balances; use both only when explicitly requested. Defaults to balances."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "transferWalletFunds",
    description:
      "Transfer real USD out of the current Discord requester's managed wallet. The only allowed destinations are another verified Discord user's managed wallet or the shared bot wallet; arbitrary blockchain addresses are never accepted. Use only when the current prompt explicitly asks to send, pay, tip, give, deposit, return, or transfer money; never use this to charge or settle a game wager. The source is always bound to the current requester and cannot be supplied by the model. A destination can be an ID, mention, username, or display name: pass the provided name directly and the tool will resolve it safely, so do not ask the user for an ID or mention. Ambiguous names fail without transferring. The bot wallet sponsors the network fee. Returns the confirmed transaction and fresh source/destination balances.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["confirmed USD amount and managed endpoints", "transaction hash and status", "fresh source and destination balances"],
    examples: ["@ai send $2 to @friend", "@ai transfer $1 back to the bot"],
    permissionRequirements: ["explicit_user_request", "requester_scope", "verified_managed_destination", "sufficient_onchain_balance"],
    auditEvents: ["tool_audit_logs", "wallet.transfer.reserved", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", enum: ["user", "bot"], description: "Managed destination type." },
        destinationUserId: { type: "string", description: "Required for destination=user. Discord ID, mention, username, or display name; plain names are resolved safely by the tool." },
        amountUsd: { type: "number", description: "Positive USD amount to transfer." }
      },
      required: ["destination", "amountUsd"],
      additionalProperties: false
    }
  },
  {
    name: "requestStarterFunds",
    description:
      "Request the fixed starter amount from the shared AI treasury for the current Discord requester. Use when someone explicitly asks for $1, starter funds, a refill, or money to start playing again. The tool verifies the requester's live onchain balance and transfers only when it is exactly $0; users with any positive balance are ineligible. The requester and destination are immutable, concurrent requests are guarded, arbitrary amounts are not accepted, and the result includes fresh user/AI balances plus a confirmed transaction.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["eligibility from verified requester balance", "fixed starter amount", "confirmed transaction", "fresh requester and AI balances"],
    examples: ["@ai I'm at $0, can I get $1 to play again?"],
    permissionRequirements: ["explicit_user_request", "requester_scope", "verified_zero_balance", "configured_wallet_runtime"],
    auditEvents: ["tool_audit_logs", "wallet.transfer.reserved", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "adminTransferWalletFunds",
    description:
      "Perform an explicit payment-admin rebalancing or corrective transfer between any two managed wallets in the current Discord server: bot to user, user to bot, or user to user. Never accepts an external address. Use only when the bot owner or payment ops requester explicitly asks to rebalance, fund, reimburse, revert, or correct wallet state. Both user endpoints must be resolved to Discord IDs first. A reason is mandatory and the requester remains durably attributed.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "ops",
    toolClass: "ops",
    outputContract: ["admin-attributed source and destination", "confirmed USD amount and transaction hash", "fresh balances", "recorded reason"],
    examples: ["@ai move $5 from the bot wallet to @friend because their payout failed", "@ai return $2 from @friend to the bot as a correction"],
    permissionRequirements: ["owner_or_ops_allowlist", "explicit_user_request", "verified_managed_endpoints", "required_reason"],
    auditEvents: ["tool_audit_logs", "wallet.transfer.reserved", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["user", "bot"] },
        sourceUserId: { type: "string", description: "Required when source=user." },
        destination: { type: "string", enum: ["user", "bot"] },
        destinationUserId: { type: "string", description: "Required when destination=user." },
        amountUsd: { type: "number", description: "Positive USD amount to transfer." },
        reason: { type: "string", description: "Required concise reason for the administrative transfer." }
      },
      required: ["source", "destination", "amountUsd", "reason"],
      additionalProperties: false
    }
  },
  {
    name: "reconcileWalletTransfers",
    description:
      "Reconcile pending or uncertain managed-wallet transfers against Tempo and expire stale wager reservations. Use only when an authorized payment admin explicitly asks to reconcile or repair wallet state. Routine reconciliation runs automatically.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "ops",
    toolClass: "ops",
    outputContract: ["checked, confirmed, and failed transfer counts", "remaining uncertain state"],
    examples: ["@ai reconcile pending wallet transfers"],
    permissionRequirements: ["owner_or_ops_allowlist", "explicit_user_request", "configured_wallet_runtime"],
    auditEvents: ["tool_audit_logs", "wallet.reconciliation.completed"],
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "getSpotifyPlaylistTracks",
    description:
      "Fetch a Spotify playlist's track list with Spotify's Web API, using current playlist item pagination and attaching the full list as CSV and text by default when available. Use this for Spotify playlist URLs/URIs or playlist IDs, especially when the user asks for every track. The result also exposes a queryable generated table for exact follow-up counts, filters, and rankings. Do not use web_fetch on open.spotify.com for playlist track lists. If Spotify denies playlist item access, return the limitation clearly instead of guessing.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["playlist metadata", "track count returned", "attached full track list when available", "queryable table when available", "Spotify URLs", "explicit limitation on 403"],
    parameters: {
      type: "object",
      properties: {
        playlistIdOrUrl: {
          type: "string",
          description: "Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks to include in the attached list. Defaults to 10000 and is capped at 10000."
        },
        format: {
          type: "string",
          enum: ["text", "csv", "both"],
          description: "Attachment format for the full track list. Defaults to both (CSV + text). Use csv to attach only CSV and text to attach only text."
        }
      },
      required: ["playlistIdOrUrl"],
      additionalProperties: false
    }
  },
  {
    name: "getSpotifyAlbumTracks",
    description:
      "Fetch a Spotify album's ordered track list with Spotify's Web API and attach the full list as CSV and text by default when available. Use this for Spotify album URLs/URIs or album IDs when the user asks what tracks are on an album, wants album duration, or wants an album tracklist. The result also exposes a queryable generated table for exact follow-up counts, filters, and rankings.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["album metadata", "track count returned", "attached full track list when available", "queryable table when available", "Spotify URLs"],
    parameters: {
      type: "object",
      properties: {
        albumIdOrUrl: {
          type: "string",
          description: "Spotify album ID, spotify:album URI, or open.spotify.com/album/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks to include in the attached list. Defaults to 200 and is capped at 500."
        },
        format: {
          type: "string",
          enum: ["text", "csv", "both"],
          description: "Attachment format for the full album track list. Defaults to both (CSV + text). Use csv to attach only CSV and text to attach only text."
        }
      },
      required: ["albumIdOrUrl"],
      additionalProperties: false
    }
  },
  {
    name: "getSpotifyArtistDiscography",
    description:
      "Fetch a Spotify artist's public discography: albums, singles, compilations, and appearances. Use this for artist URLs/URIs or artist IDs when the user asks for releases, discography, albums, singles, or where to start with an artist. The result attaches the release list as CSV and text by default and exposes a queryable generated table.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["artist metadata", "discography groups requested", "ranked release list", "attached release list when available", "queryable table when available", "Spotify URLs"],
    parameters: {
      type: "object",
      properties: {
        artistIdOrUrl: {
          type: "string",
          description: "Spotify artist ID, spotify:artist URI, or open.spotify.com/artist/<id> URL."
        },
        includeGroups: {
          type: "array",
          items: { type: "string", enum: ["album", "single", "appears_on", "compilation"] },
          description: "Release groups to include. Defaults to all four public discography groups."
        },
        limit: {
          type: "number",
          description: "Maximum releases to include. Defaults to 50 and is capped at 200."
        },
        format: {
          type: "string",
          enum: ["text", "csv", "both"],
          description: "Attachment format for the discography list. Defaults to both (CSV + text). Use csv to attach only CSV and text to attach only text."
        }
      },
      required: ["artistIdOrUrl"],
      additionalProperties: false
    }
  },
  {
    name: "getSpotifyPlaylistStats",
    description:
      "Compute deterministic, fun stats from a Spotify playlist track list: total duration, explicit count, local/unavailable count, top artists, top albums, unique artists, and repeated artists. Use this for quick rating or summarizing a playlist without using deprecated audio features or recommendations. For custom filters/rankings over the full playlist rows, export a CSV with getSpotifyPlaylistTracks and query it with queryGeneratedCsv.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["playlist metadata", "track count analyzed", "duration", "top artists", "top albums", "explicit/local counts", "Spotify URL"],
    parameters: {
      type: "object",
      properties: {
        playlistIdOrUrl: {
          type: "string",
          description: "Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks to analyze. Defaults to 10000 and is capped at 10000."
        }
      },
      required: ["playlistIdOrUrl"],
      additionalProperties: false
    }
  },
  {
    name: "compareSpotifyPlaylists",
    description:
      "Compare two Spotify playlists using public playlist item metadata: shared tracks, shared artists, unique tracks, and a track-overlap score. Use this when the user asks how similar two playlists are, what overlaps, or what one playlist has that the other does not.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["both playlist names", "track counts analyzed", "shared tracks", "shared artists", "unique counts", "overlap score"],
    parameters: {
      type: "object",
      properties: {
        playlistAIdOrUrl: {
          type: "string",
          description: "First Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        playlistBIdOrUrl: {
          type: "string",
          description: "Second Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks per playlist to compare. Defaults to 10000 and is capped at 10000."
        }
      },
      required: ["playlistAIdOrUrl", "playlistBIdOrUrl"],
      additionalProperties: false
    }
  },
  {
    name: "searchSpotify",
    description:
      "Search Spotify's public catalog for tracks, artists, albums, playlists, shows, episodes, or audiobooks using the Spotify Web API. Use this when the user asks to find music or podcasts/audiobooks on Spotify by name. Results are deterministic Spotify metadata and should be returned directly with Spotify links.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["search query", "result type", "ranked Spotify metadata", "Spotify URLs"],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query, such as track title, artist name, album name, or playlist name."
        },
        type: {
          type: "string",
          enum: ["track", "artist", "album", "playlist", "show", "episode", "audiobook"],
          description: "What to search for. Defaults to track."
        },
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 5 and Spotify's current search limit caps at 10."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "getSpotifyItem",
    description:
      "Fetch deterministic public Spotify details for one track, artist, album, playlist, show, episode, audiobook, or chapter. Use this for Spotify item URLs/URIs, or for a bare Spotify ID when the type is known. For full playlist track lists, use getSpotifyPlaylistTracks; for album track lists, use getSpotifyAlbumTracks; for artist release lists, use getSpotifyArtistDiscography.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["item type", "Spotify metadata", "Spotify URL", "explicit limitation if unavailable"],
    parameters: {
      type: "object",
      properties: {
        itemIdOrUrl: {
          type: "string",
          description: "Spotify open URL, spotify: URI, or bare Spotify ID."
        },
        type: {
          type: "string",
          enum: ["track", "artist", "album", "playlist", "show", "episode", "audiobook", "chapter"],
          description: "Required only when itemIdOrUrl is a bare ID rather than a URL or URI."
        }
      },
      required: ["itemIdOrUrl"],
      additionalProperties: false
    }
  },
  {
    name: "createDiscordPoll",
    description:
      "Create a native Discord poll in the current channel using Discord's poll message API (v10). Use this when the user asks to schedule, vote, pick a time, choose between options, run a straw poll, or create any poll-like question with multiple answers. Discord native polls render in the channel and let members click an answer. The bot must have Send Messages permission in the channel. Supports up to 10 answer options; duration defaults to 24 hours and is capped at 168 hours per Discord limits; allow_multiselect defaults to true since scheduling polls usually allow multiple answers.",
    userVisible: true,
    mutates: true,
    group: "discord-action",
    category: "discord",
    toolClass: "ops",
    outputContract: ["poll question", "answer options posted", "duration hours", "allow multiselect", "Discord message link", "failure reason when the bot lacks permission or input is invalid"],
    permissionRequirements: ["explicit_user_request", "tool_audit_log"],
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The poll question text shown above the answer options. Discord caps poll question text at 300 characters."
        },
        answers: {
          type: "array",
          items: { type: "string" },
          description: "Poll answer options. Provide between 1 and 10 options. Each answer is capped at 55 characters by Discord. Order is preserved."
        },
        durationHours: {
          type: "number",
          description: "How long the poll stays open, in hours. Defaults to 24 and is capped at 168 (7 days) per Discord limits."
        },
        allowMultiselect: {
          type: "boolean",
          description: "Whether members can select multiple answers. Defaults to true for scheduling use cases; set false for single-choice polls."
        }
      },
      required: ["question", "answers"],
      additionalProperties: false
    }
  },
  {
    name: "updateBotAvatar",
    description:
      "Update the bot's own Discord profile avatar using an image URL or a context image (generated image, uploaded attachment, or reply-chain image). Uses the Discord Modify Current User API (PATCH /users/@me with a base64 data-URI avatar). Requires the bot token from environment config. Use this when the user asks to change, set, or update the bot's avatar/profile picture. Discord accepts PNG, JPEG, WebP, or GIF avatars; large or unsupported images are rejected before the API call. Handle rate limits, permission errors, and invalid image URLs gracefully.",
    userVisible: true,
    mutates: true,
    group: "ops",
    category: "discord",
    toolClass: "ops",
    outputContract: ["image source label", "Discord avatar update status", "new avatar URL when available", "failure reason when the image is invalid, rate-limited, or unauthorized"],
    parameters: {
      type: "object",
      properties: {
        imageUrl: {
          type: "string",
          description: "Optional direct image URL to use as the new avatar. Accepts http(s) URLs or data: image URIs. If omitted, the tool falls back to a generated image, then the current request attachment, then reply-chain/message attachments."
        },
        messageIdOrUrl: {
          type: "string",
          description: "Optional Discord message ID or message URL whose visible image attachments should be used as the avatar source."
        },
        useContextImage: {
          type: "boolean",
          description: "Whether to fall back to images attached to the current request or replied-to chain when imageUrl is omitted. Defaults to true."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "setUserTurnLimit",
    description:
      "Set, clear, or list per-user daily AI turn limits. Use this when the requester asks to limit, throttle, rate-limit, or unlimit how many times a specific user can use the AI per day, or to review the current limits. A set limit overrides the global default and is enforced at Discord ingress before any model call, counted across all channels, and resets at midnight UTC. turnsPerDay accepts a positive daily cap (like 5), 0 to reject every turn, or -1 for unlimited. Pass the target's Discord user ID or mention; use findDiscordUsers to resolve a name to an ID first. Restricted to the bot owner or ops allowlist.",
    userVisible: true,
    mutates: true,
    group: "ops",
    category: "ops",
    toolClass: "ops",
    outputContract: ["action taken (set, clear, or list)", "target user ID and effective limit", "reset window", "failure reason when the user or limit is invalid"],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set", "clear", "list"],
          description: "set applies a daily limit to a user, clear removes their override, list shows all current overrides. Defaults to set."
        },
        userId: {
          type: "string",
          description: "Discord user ID or <@id> mention of the user to limit. Required for set and clear."
        },
        turnsPerDay: {
          type: "number",
          description: "Daily AI turn cap for the user. Required for set: a positive whole number like 5, 0 to reject every turn, or -1 for unlimited."
        },
        reason: {
          type: "string",
          description: "Optional short note recorded with the limit, like 'spamming every channel'."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "drawRandom",
    description:
      "Draw provably fair random outcomes using a commit-reveal RNG. ALWAYS use this tool instead of inventing results whenever a request involves chance or randomness: card games like blackjack or poker, dice rolls, coin flips, raffles, lotteries, random picks, or shuffles. Never make up random outcomes yourself. Outcomes are computed in code from a secret server seed whose SHA-256 commitment is published before results, combined with a client seed taken from the requesting Discord message id, so players can verify fairness after the seed is revealed. For a multi-digit random number, use kind=integers with count equal to the number of digits, min=0, and max=9. RNG sessions and card shoes follow the Discord reply chain: a fresh top-level prompt starts a new session, while replies continue the original game's session. A wallet-backed game reserves its wager only on the first draw. It may then either settle immediately or call awaitRandomWagerAction with complete versioned state and allowed player actions. Unknown and decision-based games default to requiring a later player reply. Real-money games based on a secret the player can reveal after the bot acts are unverifiable and will be rejected before funds are reserved. On later replies, continue the saved wager and call drawRandom without a new wager only when the selected action needs more verified chance. Never use transferWalletFunds for a wager. A proof footer is appended automatically; report drawn results exactly and do not fabricate or alter them.",
    userVisible: true,
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: [
      "drawn outcome values computed in code (never model-invented)",
      "session id, nonce, and commitment for verification",
      "automatic proof footer on the Discord reply",
      "failure reason when parameters are invalid"
    ],
    examples: [
      "@ai deal me a blackjack hand",
      "@ai roll 2d6",
      "@ai flip a coin",
      "@ai pick someone from alice, bob, carol"
    ],
    permissionRequirements: ["tool_audit_log"],
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["integers", "dice", "coin", "pick", "shuffle", "cards"],
          description:
            "What to draw: integers (uniform in [min, max]), dice (count dice with sides), coin (heads/tails), pick (choose count winners from options), shuffle (reorder options), cards (deal count cards from the conversation's shoe without replacement)."
        },
        count: {
          type: "number",
          description: "How many values to draw: integers, dice, coins, picks, or cards. Defaults to 1. Max 100."
        },
        min: { type: "number", description: "Smallest integer, inclusive. Required for kind integers." },
        max: { type: "number", description: "Largest integer, inclusive. Required for kind integers." },
        sides: { type: "number", description: "Number of die faces for kind dice. Defaults to 6." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Candidate items for kind pick or shuffle. Between 2 and 100 non-empty strings."
        },
        deckCount: {
          type: "number",
          description: "Number of 52-card decks in the shoe for kind cards (1-8). Changing it mid-session reshuffles a new shoe. Defaults to the current shoe or 1."
        },
        reason: {
          type: "string",
          description: "Short label for what this draw decides (e.g. 'player hand', 'dealer upcard', 'raffle winner'). Shown in the proof footer and stored for verification."
        },
        wager: {
          type: "object",
          description:
            "Optional wallet-backed wager. Required before the single atomic draw whenever the user is risking their bot-game balance, including vague repeats of their prior wager. The maximum payout must cover the largest possible total return, including returned stake.",
          properties: {
            stakeUsd: { type: "number", description: "Positive USD-denominated stake taken from the user's game wallet." },
            maxPayoutUsd: { type: "number", description: "Maximum possible total payout in USD, including returned stake." },
            game: { type: "string", description: "Short generic game identifier, such as slots, roulette, dice, or blackjack." }
          },
          required: ["stakeUsd", "maxPayoutUsd", "game"],
          additionalProperties: false
        }
      },
      required: ["kind"],
      additionalProperties: false
    }
  },
  {
    name: "awaitRandomWagerAction",
    description:
      "Pause an active wallet-backed game and persist everything needed for the original player to continue it in later Discord replies. Use after a wagered draw when the game has a real player decision, and again after each non-final action. State must include the full public game state, prior outcomes needed for verification, unused pre-drawn outcomes or RNG cursor information, rules, and any totals needed to continue without guessing. allowedActions must list the exact choices accepted next. On a later reply, use the state version injected into context as expectedVersion, apply only the requester's selected allowed action, then either persist the next state or settle a final outcome. Never create another wager for the same game.",
    userVisible: false,
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: ["new state version", "allowed player actions", "decision prompt", "reservation expiry behavior"],
    permissionRequirements: ["wallet_owner", "reserved_wager", "tool_audit_log"],
    auditEvents: ["wallet.wager.awaiting_action"],
    parameters: {
      type: "object",
      properties: {
        expectedVersion: { type: "number", description: "Current non-negative state version. Use 0 immediately after the initial draw." },
        state: {
          type: "object",
          description: "Complete bounded JSON game state required to continue deterministically on the next reply.",
          additionalProperties: true
        },
        allowedActions: {
          type: "array",
          items: { type: "string" },
          description: "One to twelve normalized player choices accepted next, such as hit, stand, hold, roll, or fold."
        },
        prompt: { type: "string", description: "Short conversational question asking the player for their next decision." }
      },
      required: ["expectedVersion", "state", "allowedActions", "prompt"],
      additionalProperties: false
    }
  },
  {
    name: "settleRandomWager",
    description:
      "Settle the active wallet-backed wager created by drawRandom in this player's scoped Discord game session. The runtime resolves the canonical wager automatically; never supply or repeat an internal wager id. Call this exactly once after applying the game's stated payout rules to exact provably fair results and all persisted player decisions. Interactive games may span replies through awaitRandomWagerAction; they cannot settle until a later Discord reply supplies the player's decision. Never use break-even merely because a decision is pending. payoutUsd is the total returned to the player, including returned stake: use 0 for a full loss and the original stake for an actual final break-even. outcome must agree with whether payoutUsd is above, below, or equal to the stake. Use resolutionSource=verified_randomness for automatic games and player_decision only when a persisted decision was resolved by the current reply. The service validates these facts before creating a transfer.",
    userVisible: false,
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: ["validated total payout", "net transfer status", "settlement calculation"],
    permissionRequirements: ["wallet_owner", "reserved_wager", "tool_audit_log"],
    auditEvents: ["wallet.wager.settled", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        payoutUsd: { type: "number", description: "Total USD payout including returned stake; 0 means the player loses the full stake." },
        outcome: {
          type: "string",
          enum: ["player_win", "player_loss", "push"],
          description: "Final result from the player's perspective. It must agree with payoutUsd relative to the reserved stake."
        },
        resolutionSource: {
          type: "string",
          enum: ["verified_randomness", "player_decision"],
          description: "Use verified_randomness for an automatic result; use player_decision only after a persisted interactive game receives a later player reply."
        },
        explanation: { type: "string", description: "Concise deterministic calculation from the draw result through the final outcome. It must not describe a pending decision or unfinished game." }
      },
      required: ["payoutUsd", "outcome", "resolutionSource", "explanation"],
      additionalProperties: false
    }
  },
  {
    name: "revealRandomness",
    description:
      "Reveal the secret server seed of a provably fair RNG session so anyone can verify that every draw matched the published SHA-256 commitment. Use when a user asks to verify fairness, reveal the seed, check the RNG, or finish a game session. A reply targets that reply chain's session; a standalone request targets the requester's most recently used active session in the channel. Ends the selected session and automatically publishes a fresh commitment for future draws in that reply chain. Report the revealed values exactly; the proof footer repeats them verbatim.",
    userVisible: true,
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: [
      "revealed server seed and its verified commitment",
      "client seed and per-draw outcomes",
      "verifier instructions",
      "next session commitment"
    ],
    examples: ["@ai reveal randomness", "@ai prove the blackjack deals were fair"],
    permissionRequirements: ["tool_audit_log"],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

export type OpenRouterServerToolRegistryEntry = {
  type: OpenRouterServerToolDefinition["type"];
  description: string;
  toolClass: ToolClass;
  group: ToolGroup;
  outputContract: string[];
  userVisible: boolean;
  parameters?: OpenRouterServerToolDefinition["parameters"];
};

export const openRouterServerToolRegistry: OpenRouterServerToolRegistryEntry[] = [
  {
    type: "openrouter:web_search",
    description: "Search the public web for current or external information.",
    toolClass: "external",
    group: "external",
    outputContract: ["query", "current web result summaries", "source URLs when available"],
    userVisible: true
  },
  {
    type: "openrouter:web_fetch",
    description: "Fetch and read a specific public URL when the user provides one or web search finds one worth opening.",
    toolClass: "external",
    group: "external",
    outputContract: ["requested URL", "relevant fetched page content", "source URL"],
    userVisible: true
  },
  {
    type: "openrouter:datetime",
    description: "Get the current date and time for time-sensitive questions.",
    toolClass: "external",
    group: "external",
    outputContract: ["current date/time", "timezone or locale context when available"],
    userVisible: true
  }
];

export function localToolDefinitionsForModel(tools = toolRegistry): FunctionToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: toolDescriptionForModel(tool),
      parameters: tool.parameters
    }
  }));
}

export function openRouterServerToolDefinitionsForModel(tools = openRouterServerToolRegistry): OpenRouterServerToolDefinition[] {
  return tools.map((tool) => ({
    type: tool.type,
    ...(tool.parameters ? { parameters: tool.parameters } : {})
  }));
}

export function toolDefinitionsForModel(options: { localTools?: ToolRegistryEntry[]; serverTools?: OpenRouterServerToolRegistryEntry[] } = {}): ToolDefinition[] {
  return [...localToolDefinitionsForModel(options.localTools), ...openRouterServerToolDefinitionsForModel(options.serverTools)];
}

export function toolByName(name: string): ToolRegistryEntry | undefined {
  return toolRegistry.find((tool) => tool.name === name);
}

function toolDescriptionForModel(tool: ToolRegistryEntry): string {
  const toolClass = tool.toolClass ?? defaultToolClass(tool.name);
  const outputContract = tool.outputContract ?? defaultOutputContract(tool.name);
  return `${tool.description}\nTool class: ${toolClass}. Returns: ${outputContract.join("; ")}.`;
}

export function toolContracts(): ToolContract[] {
  return toolRegistry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.category ?? defaultToolCategory(tool.name),
    toolClass: tool.toolClass ?? defaultToolClass(tool.name),
    mutates: tool.mutates,
    userVisible: tool.userVisible,
    parameters: tool.parameters,
    whenToUse: tool.description,
    outputContract: tool.outputContract ?? defaultOutputContract(tool.name),
    permissionRequirements: tool.permissionRequirements ?? defaultPermissionRequirements(tool),
    auditEvents: tool.auditEvents ?? ["tool_audit_logs", "trace_events"],
    examples: tool.examples ?? defaultToolExamples(tool.name)
  }));
}

export function renderToolList(options: { localTools?: ToolRegistryEntry[]; serverTools?: OpenRouterServerToolRegistryEntry[] } = {}) {
  const localTools = options.localTools ?? toolRegistry;
  const serverTools = options.serverTools ?? openRouterServerToolRegistry;
  return [
    "Discord AI Agent tools:",
    ...localTools.filter((tool) => tool.userVisible).map((tool) => `- ${tool.name}: ${tool.description}`),
    ...serverTools
      .filter((tool) => tool.userVisible)
      .map((tool) => `- ${tool.type.replace("openrouter:", "")}: ${tool.description}`)
  ].join("\n");
}

function defaultPermissionRequirements(tool: ToolRegistryEntry): string[] {
  if (tool.mutates) return ["explicit_user_request", "tool_audit_log"];
  if (tool.name === "inspectAgentLogs") return ["owner_or_authorized_debugger", "tool_audit_log"];
  if (tool.name.toLowerCase().includes("discord") || tool.name.startsWith("find")) {
    return ["requester_visible_discord_channels", "tool_audit_log"];
  }
  return ["tool_audit_log"];
}

function defaultToolCategory(name: ToolName): NonNullable<ToolRegistryEntry["category"]> {
  if (name === "generateImage") return "generation";
  if (name === "readGeneratedFile" || name === "queryGeneratedCsv" || name === "queryGeneratedTable") return "memory";
  if (name === "createSkillDraft") return "memory";
  if (
    name === "runCodingAgent" ||
    name === "getAgentTaskStatus" ||
    name === "listAgentTasks" ||
    name === "retryAgentTask" ||
    name === "cancelAgentTask"
  ) {
    return "coding";
  }
  if (name === "inspectAgentLogs" || name === "reportStatus" || name === "getDeploymentStatus" || name === "getSpendSummary" || name === "listTools") return "ops";
  if (
    name === "getSpotifyPlaylistTracks" ||
    name === "getSpotifyAlbumTracks" ||
    name === "getSpotifyArtistDiscography" ||
    name === "getSpotifyPlaylistStats" ||
    name === "compareSpotifyPlaylists" ||
    name === "searchSpotify" ||
    name === "getSpotifyItem"
  ) {
    return "external";
  }
  if (name === "getWalletBalance" || name === "listWalletBalances" || name === "transferWalletFunds" || name === "requestStarterFunds") return "external";
  return "discord";
}

const toolClassByName: Record<ToolName, ToolClass> = {
  listTools: "ops",
  requestAdditionalTools: "ops",
  findDiscordUsers: "resolver",
  findDiscordChannels: "resolver",
  searchDiscordHistory: "retrieval",
  getRecentAgentMemory: "memory",
  getAgentMemoryStats: "memory",
  getRecentDiscordMessages: "retrieval",
  getDiscordMessageContext: "retrieval",
  searchDiscordAttachments: "retrieval",
  inspectDiscordFile: "retrieval",
  inspectDiscordImages: "image",
  getDiscordUserAvatar: "resolver",
  getDiscordStats: "stats",
  getDiscordChannelTopics: "summary",
  summarizeDiscordHistory: "summary",
  summarizeDiscordThread: "summary",
  generateImage: "generation",
  readGeneratedFile: "retrieval",
  queryGeneratedCsv: "stats",
  queryGeneratedTable: "stats",
  createSkillDraft: "memory",
  runCodingAgent: "coding",
  getAgentTaskStatus: "coding",
  listAgentTasks: "coding",
  retryAgentTask: "coding",
  cancelAgentTask: "coding",
  getDeploymentStatus: "ops",
  getSpendSummary: "ops",
  inspectAgentLogs: "ops",
  undoConversationTurns: "memory",
  reportStatus: "ops",
  getWalletBalance: "external",
  listWalletBalances: "external",
  transferWalletFunds: "external",
  requestStarterFunds: "external",
  adminTransferWalletFunds: "ops",
  reconcileWalletTransfers: "ops",
  getSpotifyPlaylistTracks: "external",
  getSpotifyAlbumTracks: "external",
  getSpotifyArtistDiscography: "external",
  getSpotifyPlaylistStats: "external",
  compareSpotifyPlaylists: "external",
  searchSpotify: "external",
  getSpotifyItem: "external",
  createDiscordPoll: "ops",
  updateBotAvatar: "ops",
  setUserTurnLimit: "ops",
  drawRandom: "generation",
  awaitRandomWagerAction: "generation",
  settleRandomWager: "generation",
  revealRandomness: "generation"
};

const outputContractByToolClass: Record<ToolClass, string[]> = {
  resolver: ["resolved IDs", "display names", "match confidence or ambiguity notes", "result count"],
  retrieval: ["applied filters", "ranked evidence snippets", "match sources when available", "Discord message links when available", "result count"],
  memory: ["memory scope", "durable action or retrieved turns", "audit trail"],
  stats: ["metric", "grouping", "filters", "ranked rows", "result count"],
  summary: ["question or focus", "sample window", "grounded summary", "coverage limits"],
  image: ["image URLs or attachment IDs", "visual observations", "uncertainty when the image is unclear"],
  generation: ["generation prompt", "reference image count", "attached output file or URL"],
  coding: ["task ID and status", "run-console link when available", "PR link or failure reason", "progress summary"],
  ops: ["requested diagnostic", "current status", "recent failures or next action"],
  external: ["external request", "returned source data", "source URLs when available"]
};

function defaultToolClass(name: ToolName): ToolClass {
  return toolClassByName[name];
}

function defaultOutputContract(name: ToolName): string[] {
  return outputContractByToolClass[defaultToolClass(name)];
}

function defaultToolExamples(name: ToolName): string[] {
  const examples: Record<ToolName, string> = {
    listTools: "@ai tools",
    requestAdditionalTools: "@ai I need another capability",
    findDiscordUsers: "@ai find user tyler",
    findDiscordChannels: "@ai find channel movies",
    searchDiscordHistory: "@ai what did we say about job hunting?",
    getRecentAgentMemory: "@ai what did you just say?",
    getAgentMemoryStats: "@ai how many turns have you completed since this message?",
    getRecentDiscordMessages: "@ai what just happened in here?",
    getDiscordMessageContext: "@ai show the context around this message link",
    searchDiscordAttachments: "@ai find the image of nachos",
    inspectDiscordFile: "@ai read the file I replied to",
    inspectDiscordImages: "@ai what is in this screenshot?",
    getDiscordUserAvatar: "@ai enhance my profile picture",
    getDiscordStats: "@ai rank channels by messages per day",
    getDiscordChannelTopics: "@ai what are the main recurring topics in each channel?",
    summarizeDiscordHistory: "@ai what has tyler been up to recently?",
    summarizeDiscordThread: "@ai summarize this thread",
    generateImage: "@ai make an image of a wizard eating nachos",
    readGeneratedFile: "@ai show me the first rows of the file you just generated",
    queryGeneratedCsv: "@ai rank the artists in the CSV you just generated",
    queryGeneratedTable: "@ai rank the artists in the table you just generated",
    createSkillDraft: "@ai learn this for next time: movie night is on Fridays",
    runCodingAgent: "@ai debug the failing CI on that PR",
    getAgentTaskStatus: "@ai what happened to the last update?",
    listAgentTasks: "@ai show recent update tasks",
    retryAgentTask: "@ai retry that update",
    cancelAgentTask: "@ai cancel the current update",
    getDeploymentStatus: "@ai deployment status",
    getSpendSummary: "@ai how much have we spent today?",
    inspectAgentLogs: "@ai why did that last answer fail?",
    undoConversationTurns: "@ai undo that",
    reportStatus: "@ai status",
    getWalletBalance: "@ai what's my bankroll?",
    listWalletBalances: "@ai what's the balance of every user in this server?",
    transferWalletFunds: "@ai send $2 to @friend",
    requestStarterFunds: "@ai I'm at $0, can I get $1 to play again?",
    adminTransferWalletFunds: "@ai move $5 from the bot wallet to @friend because their payout failed",
    reconcileWalletTransfers: "@ai reconcile pending wallet transfers",
    getSpotifyPlaylistTracks: "@ai list all the tracks in this Spotify playlist: https://open.spotify.com/playlist/abc123",
    getSpotifyAlbumTracks: "@ai list the tracks on this Spotify album: https://open.spotify.com/album/abc123",
    getSpotifyArtistDiscography: "@ai show me this artist's Spotify discography: https://open.spotify.com/artist/abc123",
    getSpotifyPlaylistStats: "@ai give me fun stats for this Spotify playlist: https://open.spotify.com/playlist/abc123",
    compareSpotifyPlaylists: "@ai compare these two Spotify playlists: https://open.spotify.com/playlist/abc123 and https://open.spotify.com/playlist/def456",
    searchSpotify: "@ai search Spotify for Running Up That Hill",
    getSpotifyItem: "@ai what is this Spotify track? https://open.spotify.com/track/abc123",
    createDiscordPoll: "@ai make a poll: what day should we play, Friday or Saturday?",
    updateBotAvatar: "@ai change your avatar to this image: https://example.com/avatar.png",
    setUserTurnLimit: "@ai limit tyler to 5 posts per day",
    drawRandom: "@ai deal me a blackjack hand",
    awaitRandomWagerAction: "@ai hit",
    settleRandomWager: "@ai settle the wager from that draw",
    revealRandomness: "@ai reveal randomness"
  };
  return [examples[name]];
}

export function toolSupportsCsvFormat(name: ToolName): boolean {
  const tool = toolByName(name);
  const properties = tool?.parameters.properties as Record<string, unknown> | undefined;
  const format = properties?.format as { enum?: unknown[] } | undefined;
  return Array.isArray(format?.enum) && format.enum.includes("csv");
}
