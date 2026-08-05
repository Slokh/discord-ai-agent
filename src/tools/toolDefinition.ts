import type { FunctionToolDefinition } from "../models/openrouter.js";
import type { AppConfig } from "../config/env.js";

/** The complete model-facing surface, grouped by the capability that owns it. */
export const TOOL_NAMES_BY_CAPABILITY = {
  foundation: ["loadSkillContext", "setMyTimezone"],
  reminders: ["createReminder", "listMyReminders", "cancelReminder"],
  discordContext: [
    "composeDiscordResponse", "findDiscordUsers", "findDiscordChannels", "searchDiscordHistory",
    "getRecentAgentMemory", "getAgentMemoryStats", "getRecentDiscordMessages", "getDiscordMessageContext",
    "listMyImprovementSignals", "searchDiscordAttachments", "inspectDiscordFile", "getDiscordStats",
    "getDiscordChannelTopics", "summarizeDiscordHistory", "summarizeDiscordThread",
  ],
  images: ["inspectDiscordImages", "getDiscordUserAvatar", "generateImage"],
  generatedData: ["readGeneratedFile", "queryGeneratedCsv", "queryGeneratedTable"],
  operations: ["getDeploymentStatus", "getSpendSummary", "reportStatus", "setAgentModel"],
  improvements: ["reportImprovementSignal"],
  codeUpdates: ["runCodingAgent", "getAgentTaskStatus", "listAgentTasks", "retryAgentTask", "cancelAgentTask"],
  discordActions: ["undoConversationTurns", "addDiscordReaction", "createDiscordPoll", "createDiscordEmoji", "updateBotAvatar"],
  randomGames: ["drawRandom", "awaitRandomWagerAction", "settleRandomWager", "revealRandomness"],
  wallets: [
    "getWalletBalance", "listWalletBalances", "getWagerHistory", "transferWalletFunds", "requestStarterFunds",
    "adminTransferWalletFunds", "adminSetWalletStarterAmount", "getWalletFeeSummary", "reconcileWalletTransfers",
  ],
  spotify: [
    "getSpotifyPlaylistTracks", "getSpotifyAlbumTracks", "getSpotifyArtistDiscography", "getSpotifyPlaylistStats",
    "compareSpotifyPlaylists", "searchSpotify", "getSpotifyItem",
  ],
  externalResearch: ["web__run"],
} as const;

export type ToolName = (typeof TOOL_NAMES_BY_CAPABILITY)[keyof typeof TOOL_NAMES_BY_CAPABILITY][number];
export const TOOL_NAMES: readonly ToolName[] = Object.values(TOOL_NAMES_BY_CAPABILITY).flat();
export const MUTATING_TOOL_NAMES = [
  "setMyTimezone",
  "createReminder",
  "cancelReminder",
  "setAgentModel",
  "runCodingAgent",
  "retryAgentTask",
  "cancelAgentTask",
  "undoConversationTurns",
  "addDiscordReaction",
  "createDiscordPoll",
  "createDiscordEmoji",
  "updateBotAvatar",
  "drawRandom",
  "awaitRandomWagerAction",
  "settleRandomWager",
  "revealRandomness",
  "transferWalletFunds",
  "requestStarterFunds",
  "adminTransferWalletFunds",
  "adminSetWalletStarterAmount",
  "reconcileWalletTransfers",
] as const satisfies readonly ToolName[];

export type ToolGroup = "core" | "discord-retrieval" | "generated-data" | "presentation" | "discord-action" | "image" | "spotify" | "codegen" | "ops" | "external";

export type ToolClass = "resolver" | "retrieval" | "memory" | "stats" | "summary" | "image" | "generation" | "coding" | "ops" | "external";

export type ToolRegistryEntry = {
  name: ToolName;
  description: string;
  mutates: boolean;
  category: "discord" | "generation" | "memory" | "ops" | "coding" | "external";
  group: ToolGroup;
  available?: (config: AppConfig) => boolean;
  accessPolicy: "default" | "strict_ops";
  scopeForDeployment?: (tool: ToolRegistryEntry, config: AppConfig) => ToolRegistryEntry;
  toolClass: ToolClass;
  outputContract: string[];
  examples: string[];
  permissionRequirements: string[];
  auditEvents: string[];
  argumentExamples: Record<string, unknown>[];
  repeatPolicy: "allow" | "reuse_identical_success";
  latencyBudgetMs: number;
  parameters: FunctionToolDefinition["function"]["parameters"];
};

type ToolDefinitionInput = Omit<ToolRegistryEntry, "outputContract" | "permissionRequirements" | "auditEvents" | "argumentExamples" | "accessPolicy" | "repeatPolicy" | "latencyBudgetMs"> &
  Partial<Pick<ToolRegistryEntry, "outputContract" | "permissionRequirements" | "auditEvents" | "argumentExamples" | "accessPolicy" | "repeatPolicy" | "latencyBudgetMs">>;

const outputContractByToolClass: Record<ToolClass, string[]> = {
  resolver: ["resolved IDs", "display names", "match confidence or ambiguity notes", "result count"],
  retrieval: ["applied filters", "ranked evidence snippets", "match sources when available", "Discord message links when available", "result count"],
  memory: ["memory scope", "durable action or retrieved turns", "audit trail"],
  stats: ["metric", "grouping", "filters", "ranked rows", "result count"],
  summary: ["question or focus", "sample window", "grounded summary", "coverage limits"],
  image: ["image URLs or attachment IDs", "visual observations", "uncertainty when the image is unclear"],
  generation: ["generation prompt", "reference image count", "attached output file or URL"],
  coding: ["task ID and status", "PR link or failure reason", "progress summary"],
  ops: ["requested diagnostic", "current status", "recent failures or next action"],
  external: ["external request", "returned source data", "source URLs when available"]
};

const latencyBudgetMsByToolClass: Record<ToolClass, number> = {
  resolver: 10_000,
  retrieval: 15_000,
  memory: 10_000,
  stats: 20_000,
  summary: 60_000,
  image: 60_000,
  generation: 120_000,
  coding: 10_000,
  ops: 15_000,
  external: 30_000,
};

/** Materializes one complete contract from explicit taxonomy plus generic policy defaults. */
export function defineTool<const T extends ToolDefinitionInput>(definition: T): T & ToolRegistryEntry {
  return {
    ...definition,
    accessPolicy: definition.accessPolicy ?? "default",
    repeatPolicy: definition.repeatPolicy ?? "allow",
    latencyBudgetMs: definition.latencyBudgetMs ?? latencyBudgetMsByToolClass[definition.toolClass],
    outputContract: definition.outputContract ?? outputContractByToolClass[definition.toolClass],
    permissionRequirements: definition.permissionRequirements ?? (
      definition.mutates
        ? ["explicit_user_request", "tool_audit_log"]
        : definition.category === "discord"
          ? ["requester_visible_discord_channels", "tool_audit_log"]
          : ["tool_audit_log"]
    ),
    auditEvents: definition.auditEvents ?? ["tool_audit_logs", "agent_runtime_events"],
    argumentExamples: definition.argumentExamples ?? [],
  };
}

/** Applies one capability-owned deployment predicate to a focused contract family. */
export function installToolsWhen<const T extends readonly ToolRegistryEntry[]>(
  available: (config: AppConfig) => boolean,
  tools: T,
): T {
  return tools.map((tool) => ({ ...tool, available })) as unknown as T;
}

/** Binds contracts to execution handlers once at startup and fails fast on drift. */
export function bindToolHandlers<H>(
  contracts: readonly ToolRegistryEntry[],
  handlers: Partial<Record<ToolName, H>>,
  delegated: readonly ToolName[] = [],
): Readonly<Partial<Record<ToolName, H>>> {
  const contractNames = new Set(contracts.map((contract) => contract.name));
  const delegatedNames = new Set(delegated);
  const missing = [...contractNames].filter((name) => handlers[name] === undefined && !delegatedNames.has(name));
  const unknown = Object.keys(handlers).filter((name) => !contractNames.has(name as ToolName));
  if (missing.length || unknown.length) {
    throw new Error(`Tool execution registry mismatch (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`);
  }
  return Object.freeze({ ...handlers });
}
