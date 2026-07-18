import type { FunctionToolDefinition, OpenRouterServerToolDefinition, ToolDefinition } from "../models/openrouter.js";
import type { ToolClass, ToolContract, ToolGroup, ToolName, ToolRegistryEntry } from "./toolDefinition.js";
import { localToolContracts } from "./contracts/index.js";
export { TOOL_GROUPS } from "./toolDefinition.js";
export type { ToolClass, ToolContract, ToolGroup, ToolName, ToolRegistryEntry } from "./toolDefinition.js";

export const toolRegistry: ToolRegistryEntry[] = [...localToolContracts];
const toolByNameIndex = new Map(toolRegistry.map((tool) => [tool.name, tool]));
const localDefinitionCache = new WeakMap<ToolRegistryEntry, FunctionToolDefinition>();
const localDefinitionListCache = new WeakMap<ToolRegistryEntry[], FunctionToolDefinition[]>();
const serverDefinitionListCache = new WeakMap<OpenRouterServerToolRegistryEntry[], OpenRouterServerToolDefinition[]>();
const combinedDefinitionCache = new WeakMap<object, WeakMap<object, ToolDefinition[]>>();

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
  const cachedList = localDefinitionListCache.get(tools);
  if (cachedList) return cachedList;
  const definitions = tools.map((tool) => {
    const cached = localDefinitionCache.get(tool);
    if (cached) return cached;
    const definition: FunctionToolDefinition = {
      type: "function",
      function: { name: tool.name, description: toolDescriptionForModel(tool), parameters: tool.parameters }
    };
    localDefinitionCache.set(tool, definition);
    return definition;
  });
  localDefinitionListCache.set(tools, definitions);
  return definitions;
}

export function openRouterServerToolDefinitionsForModel(tools = openRouterServerToolRegistry): OpenRouterServerToolDefinition[] {
  const cached = serverDefinitionListCache.get(tools);
  if (cached) return cached;
  const definitions = tools.map((tool) => ({
    type: tool.type,
    ...(tool.parameters ? { parameters: tool.parameters } : {})
  }));
  serverDefinitionListCache.set(tools, definitions);
  return definitions;
}

export function toolDefinitionsForModel(options: { localTools?: ToolRegistryEntry[]; serverTools?: OpenRouterServerToolRegistryEntry[] } = {}): ToolDefinition[] {
  const localTools = options.localTools ?? toolRegistry;
  const serverTools = options.serverTools ?? openRouterServerToolRegistry;
  let byServer = combinedDefinitionCache.get(localTools);
  if (!byServer) {
    byServer = new WeakMap();
    combinedDefinitionCache.set(localTools, byServer);
  }
  const cached = byServer.get(serverTools);
  if (cached) return cached;
  const definitions = [...localToolDefinitionsForModel(localTools), ...openRouterServerToolDefinitionsForModel(serverTools)];
  byServer.set(serverTools, definitions);
  return definitions;
}

export function toolByName(name: string): ToolRegistryEntry | undefined {
  return toolByNameIndex.get(name as ToolName);
}

function toolDescriptionForModel(tool: ToolRegistryEntry): string {
  const toolClass = tool.toolClass ?? defaultToolClass(tool.name);
  const outputContract = tool.outputContract ?? defaultOutputContract(tool.name);
  return `${tool.description}\nTool class: ${toolClass}. Returns: ${outputContract.join("; ")}.`;
}

let cachedToolContracts: ToolContract[] | undefined;
export function toolContracts(): ToolContract[] {
  return cachedToolContracts ??= toolRegistry.map((tool) => ({
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
  if (name === "createSkillDraft" || name === "manageSkills") return "memory";
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
  if (name === "getWalletBalance" || name === "listWalletBalances" || name === "getWagerHistory" || name === "transferWalletFunds" || name === "requestStarterFunds") return "external";
  return "discord";
}

const toolClassByName: Record<ToolName, ToolClass> = {
  listTools: "ops",
  requestAdditionalTools: "ops",
  composeDiscordResponse: "generation",
  findDiscordUsers: "resolver",
  findDiscordChannels: "resolver",
  searchDiscordHistory: "retrieval",
  getRecentAgentMemory: "memory",
  getAgentMemoryStats: "memory",
  getRecentDiscordMessages: "retrieval",
  getDiscordMessageContext: "retrieval",
  listDiscordBugMarkers: "retrieval",
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
  manageSkills: "memory",
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
  getWagerHistory: "external",
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
  createDiscordEmoji: "ops",
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

const defaultToolExampleByName: Record<ToolName, string> = {
    listTools: "@ai tools",
    requestAdditionalTools: "@ai I need another capability",
    composeDiscordResponse: "@ai show these choices as buttons",
    findDiscordUsers: "@ai find user tyler",
    findDiscordChannels: "@ai find channel movies",
    searchDiscordHistory: "@ai what did we say about job hunting?",
    getRecentAgentMemory: "@ai what did you just say?",
    getAgentMemoryStats: "@ai how many turns have you completed since this message?",
    getRecentDiscordMessages: "@ai what just happened in here?",
    getDiscordMessageContext: "@ai show the context around this message link",
    listDiscordBugMarkers: "@ai fix everything in my bug inbox",
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
    manageSkills: "@ai what are all your skills?",
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
    getWagerHistory: "@ai what were the results of my coin flips?",
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
    createDiscordEmoji: "@ai upload this image as a server emoji named nacho_wizard",
    updateBotAvatar: "@ai change your avatar to this image: https://example.com/avatar.png",
    setUserTurnLimit: "@ai limit tyler to 5 posts per day",
    drawRandom: "@ai deal me a blackjack hand",
    awaitRandomWagerAction: "@ai hit",
    settleRandomWager: "@ai settle the wager from that draw",
    revealRandomness: "@ai reveal randomness"
};

function defaultToolExamples(name: ToolName): string[] {
  return [defaultToolExampleByName[name]];
}

export function toolSupportsCsvFormat(name: ToolName): boolean {
  const tool = toolByName(name);
  const properties = tool?.parameters.properties as Record<string, unknown> | undefined;
  const format = properties?.format as { enum?: unknown[] } | undefined;
  return Array.isArray(format?.enum) && format.enum.includes("csv");
}
