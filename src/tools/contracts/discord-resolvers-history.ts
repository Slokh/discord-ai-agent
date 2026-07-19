import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const discordResolverHistoryToolContracts = [
  defineTool({
    name: "findDiscordUsers",
    category: "discord",
    toolClass: "resolver",
    examples: ["@ai find user tyler"],
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
  }),

  defineTool({
    name: "findDiscordChannels",
    category: "discord",
    toolClass: "resolver",
    examples: ["@ai find channel movies"],
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
  }),

  defineTool({
    name: "searchDiscordHistory",
    category: "discord",
    toolClass: "retrieval",
    examples: ["@ai what did we say about job hunting?"],
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
  }),

  defineTool({
    name: "getRecentAgentMemory",
    toolClass: "memory",
    examples: ["@ai what did you just say?"],
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
  }),

  defineTool({
    name: "getAgentMemoryStats",
    toolClass: "memory",
    examples: ["@ai how many turns have you completed since this message?"],
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
  }),
] satisfies ToolRegistryEntry[];
