import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const discordRetrievalPart3ToolContracts = [
  defineTool({
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
  }),

  defineTool({
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
  }),

  defineTool({
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
  }),

  defineTool({
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
  }),
] satisfies ToolRegistryEntry[];
