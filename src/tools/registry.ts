import type { FunctionToolDefinition, OpenRouterServerToolDefinition, ToolDefinition } from "../models/openrouter.js";

export type ToolName =
  | "listTools"
  | "findDiscordUsers"
  | "findDiscordChannels"
  | "findDiscordRoles"
  | "searchDiscordHistory"
  | "getRecentDiscordMessages"
  | "getDiscordMessageContext"
  | "searchDiscordAttachments"
  | "getPinnedMessages"
  | "getDiscordStats"
  | "analyzeDiscordData"
  | "getDiscordChannelTopics"
  | "summarizeDiscordHistory"
  | "summarizeDiscordThread"
  | "generateImage"
  | "createSkillDraft"
  | "openGithubPullRequest"
  | "inspectAgentLogs"
  | "inspectRailwayLogs"
  | "undoConversationTurns"
  | "reportStatus";

export type ToolRegistryEntry = {
  name: ToolName;
  description: string;
  userVisible: boolean;
  mutates: boolean;
  category?: "discord" | "generation" | "memory" | "ops" | "coding";
  examples?: string[];
  permissionRequirements?: string[];
  auditEvents?: string[];
  parameters: FunctionToolDefinition["function"]["parameters"];
};

export type ToolContract = {
  name: ToolName;
  description: string;
  category: NonNullable<ToolRegistryEntry["category"]>;
  mutates: boolean;
  userVisible: boolean;
  parameters: FunctionToolDefinition["function"]["parameters"];
  whenToUse: string;
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
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "findDiscordUsers",
    description:
      "Intermediate resolver: find Discord users by username, display name, nickname-like text, mention, or ID before filtering history/stats by author. Do not answer from this alone when the user asked what someone said, did, or has been up to; call the relevant history, summary, or stats tool next.",
    userVisible: true,
    mutates: false,
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
    name: "findDiscordRoles",
    description: "Intermediate resolver: find Discord roles by role name or ID from the current guild before using role information in another answer.",
    userVisible: true,
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Role name, role mention, or Discord role ID to resolve."
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
      "Search permission-filtered indexed Discord history. Use for questions about what people in this Discord server said, sent, remembered, or asked before. Do not use for public web facts unless the user asks what this server said about them. Prefer a short focused search phrase, not the entire user request. Use structured authorIds/channelIds after findDiscordUsers/findDiscordChannels when names are ambiguous. One or two distinct searches is usually enough before answering. Supports filter syntax like from:name, in:channel, after:YYYY-MM-DD, before:YYYY-MM-DD.",
    userVisible: true,
    mutates: false,
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
    name: "getRecentDiscordMessages",
    description: "Get recent indexed messages from the current channel or specified visible channels.",
    userVisible: true,
    mutates: false,
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
    description: "Search indexed Discord attachments by filename, content type, surrounding message text, author, or channel.",
    userVisible: true,
    mutates: false,
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
    name: "getPinnedMessages",
    description: "Get indexed pinned messages from the current channel or specified visible channels.",
    userVisible: true,
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        channelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional visible channel/thread IDs. Defaults to the current channel."
        },
        limit: {
          type: "number",
          description: "Maximum pinned messages. Defaults to 20."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "getDiscordStats",
    description:
      "Compute permission-filtered Discord analytics over indexed visible messages. Use this for counts, rankings, lowest/highest rankings, activity over time, messages by channel/user, normalized messages-per-day comparisons, attachment stats, reaction totals, and active-day summaries.",
    userVisible: true,
    mutates: false,
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
    name: "analyzeDiscordData",
    description:
      "Run model-planned, permission-filtered analysis over indexed Discord messages. Use this for ad hoc questions that need extracting a repeated text format, deduping, doing exact math, or building a leaderboard from many messages.",
    userVisible: true,
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The user's analysis question, including what should be calculated and how the result should be interpreted."
        },
        query: {
          type: "string",
          description: "Broad keyword query used to fetch a permission-filtered sample for plan inference, such as wordle, fantasy, prediction, rating, or score."
        },
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
        includeBots: {
          type: "boolean",
          description: "Whether to include bot-authored messages. Defaults to false."
        },
        sampleLimit: {
          type: "number",
          description: "Maximum sample messages to show the planner. Defaults to 80."
        },
        resultLimit: {
          type: "number",
          description: "Maximum result rows/top items to return. Defaults to 10."
        }
      },
      required: ["task"],
      additionalProperties: false
    }
  },
  {
    name: "getDiscordChannelTopics",
    description:
      "Summarize the main recurring topics, themes, memes, and bits in major Discord channels using sampled indexed messages and stored embeddings. Use this for 'what do people talk about in each channel' rather than exact counts.",
    userVisible: true,
    mutates: false,
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
    description: "Summarize indexed messages from the current channel or thread.",
    userVisible: true,
    mutates: false,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "generateImage",
    description: "Generate an image with the configured OpenRouter image model.",
    userVisible: true,
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The image prompt to generate."
        }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  {
    name: "createSkillDraft",
    description:
      "Create or update a private database-backed Markdown skill. Use only when the user explicitly asks the agent to learn, remember, save, or update durable behavior/knowledge for next time.",
    userVisible: true,
    mutates: true,
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
    name: "openGithubPullRequest",
    description:
      "Run a Railway codegen worker job for a requested Discord AI Agent update, wait for the result, and return the PR link only when it creates a real code diff. Use when the user explicitly asks the agent to update itself, add, build, implement, or change behavior.",
    userVisible: true,
    mutates: true,
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "The requested agent update, integration, or repository change to implement."
        }
      },
      required: ["request"],
      additionalProperties: false
    }
  },
  {
    name: "undoConversationTurns",
    description:
      "Undo the agent's most recent reply turns in the current Discord channel by removing them from persistent memory and, when possible, deleting the bot reply messages. Use when the user asks to undo, forget, delete, or remove the agent's previous response.",
    userVisible: true,
    mutates: true,
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
      "Inspect Discord AI Agent's own recent trace events and tool audit logs for debugging slow, failed, hung, or confusing bot behavior. traceId is usually the originating Discord message ID.",
    userVisible: true,
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        traceId: {
          type: "string",
          description: "Optional trace ID or originating Discord message ID to inspect."
        },
        limit: {
          type: "number",
          description: "Maximum trace events and tool logs to return. Defaults to 20."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "inspectRailwayLogs",
    description:
      "Owner-only. Inspect Railway deployment logs for Discord AI Agent bot/worker infrastructure debugging when app traces are missing, startup failed, deployments are suspect, or Railway/runtime errors are needed.",
    userVisible: false,
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: ["discord-ai-agent-bot", "discord-ai-agent-worker"],
          description: "Railway service to inspect. Defaults to discord-ai-agent-bot."
        },
        since: {
          type: "string",
          description: "Relative time window up to 6h, like 30m, 2h, or 45s. Defaults to 30m."
        },
        lines: {
          type: "number",
          description: "Maximum log lines, capped at 200. Defaults to 100."
        },
        filter: {
          type: "string",
          description: "Optional Railway log filter, such as @level:error or a text search."
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
  userVisible: boolean;
  parameters?: OpenRouterServerToolDefinition["parameters"];
};

export const openRouterServerToolRegistry: OpenRouterServerToolRegistryEntry[] = [
  {
    type: "openrouter:web_search",
    description: "Search the public web for current or external information.",
    userVisible: true
  },
  {
    type: "openrouter:web_fetch",
    description: "Fetch and read a specific public URL when the user provides one or web search finds one worth opening.",
    userVisible: true
  },
  {
    type: "openrouter:datetime",
    description: "Get the current date and time for time-sensitive questions.",
    userVisible: true
  }
];

export function localToolDefinitionsForModel(): FunctionToolDefinition[] {
  return toolRegistry.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

export function openRouterServerToolDefinitionsForModel(): OpenRouterServerToolDefinition[] {
  return openRouterServerToolRegistry.map((tool) => ({
    type: tool.type,
    ...(tool.parameters ? { parameters: tool.parameters } : {})
  }));
}

export function toolDefinitionsForModel(): ToolDefinition[] {
  return [...localToolDefinitionsForModel(), ...openRouterServerToolDefinitionsForModel()];
}

export function toolByName(name: string): ToolRegistryEntry | undefined {
  return toolRegistry.find((tool) => tool.name === name);
}

export function toolContracts(): ToolContract[] {
  return toolRegistry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.category ?? defaultToolCategory(tool.name),
    mutates: tool.mutates,
    userVisible: tool.userVisible,
    parameters: tool.parameters,
    whenToUse: tool.description,
    permissionRequirements: tool.permissionRequirements ?? defaultPermissionRequirements(tool),
    auditEvents: tool.auditEvents ?? ["tool_audit_logs", "trace_events"],
    examples: tool.examples ?? defaultToolExamples(tool.name)
  }));
}

export function renderToolList() {
  return [
    "Discord AI Agent tools:",
    ...toolRegistry.filter((tool) => tool.userVisible).map((tool) => `- ${tool.name}: ${tool.description}`),
    ...openRouterServerToolRegistry
      .filter((tool) => tool.userVisible)
      .map((tool) => `- ${tool.type.replace("openrouter:", "")}: ${tool.description}`)
  ].join("\n");
}

function defaultPermissionRequirements(tool: ToolRegistryEntry): string[] {
  if (tool.mutates) return ["explicit_user_request", "tool_audit_log"];
  if (tool.name.startsWith("inspect")) return ["owner_or_authorized_debugger", "tool_audit_log"];
  if (tool.name.toLowerCase().includes("discord") || tool.name.startsWith("find")) {
    return ["requester_visible_discord_channels", "tool_audit_log"];
  }
  return ["tool_audit_log"];
}

function defaultToolCategory(name: ToolName): NonNullable<ToolRegistryEntry["category"]> {
  if (name === "generateImage") return "generation";
  if (name === "createSkillDraft") return "memory";
  if (name === "openGithubPullRequest") return "coding";
  if (name === "inspectAgentLogs" || name === "inspectRailwayLogs" || name === "reportStatus" || name === "listTools") return "ops";
  return "discord";
}

function defaultToolExamples(name: ToolName): string[] {
  const examples: Record<ToolName, string> = {
    listTools: "@ai tools",
    findDiscordUsers: "@ai find user tyler",
    findDiscordChannels: "@ai find channel movies",
    findDiscordRoles: "@ai find role admin",
    searchDiscordHistory: "@ai what did we say about job hunting?",
    getRecentDiscordMessages: "@ai what just happened in here?",
    getDiscordMessageContext: "@ai show the context around this message link",
    searchDiscordAttachments: "@ai find the image of nachos",
    getPinnedMessages: "@ai what is pinned in this channel?",
    getDiscordStats: "@ai rank channels by messages per day",
    analyzeDiscordData: "@ai who is the top Wordle player?",
    getDiscordChannelTopics: "@ai what are the main recurring topics in each channel?",
    summarizeDiscordHistory: "@ai what has tyler been up to recently?",
    summarizeDiscordThread: "@ai summarize this thread",
    generateImage: "@ai make an image of a wizard eating nachos",
    createSkillDraft: "@ai learn this for next time: movie night is on Fridays",
    openGithubPullRequest: "@ai update yourself to handle Bluesky links better",
    inspectAgentLogs: "@ai why did that last answer fail?",
    inspectRailwayLogs: "@ai check railway bot logs for errors",
    undoConversationTurns: "@ai undo that",
    reportStatus: "@ai status"
  };
  return [examples[name]];
}
