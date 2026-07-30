import { hasGitHubTaskCredential, type AppConfig } from "../config/env.js";
import {
  openRouterServerToolRegistry,
  TOOL_GROUPS,
  toolRegistry,
  type OpenRouterServerToolRegistryEntry,
  type ToolGroup,
  type ToolRegistryEntry,
} from "./registry.js";
import { toolForDeployment } from "./toolDeployment.js";

export type ToolScopeInput = {
  text: string;
  hasImageAttachments: boolean;
  hasFileAttachments?: boolean;
  config: AppConfig;
  replyContext?: boolean;
  replyContextText?: string;
};

export type ScopedToolset = {
  groups: Set<ToolGroup>;
  localTools: ToolRegistryEntry[];
  serverTools: OpenRouterServerToolRegistryEntry[];
};

const TOOL_GROUP_DESCRIPTIONS: Record<ToolGroup, string> = {
  core: "tool discovery and loading named skills",
  "discord-retrieval": "permission-filtered Discord history, files, memory, statistics, and summaries",
  "generated-data": "reading, querying, counting, and filtering generated files and tables",
  presentation: "native Discord components such as buttons, forms, and galleries",
  "discord-action": "Discord mutations, polls, reactions, profile changes, and provably fair randomness",
  image: "image understanding, avatar inspection, and image generation",
  spotify: "Spotify catalog, playlist, album, artist, and comparison data",
  codegen: "repository changes, pull requests, CI, and deployment work",
  ops: "agent diagnostics, status, spend, tasks, and model/skill administration",
  external: "public web/current information and managed-wallet reads/actions",
};

export function selectToolGroups(input: ToolScopeInput): Set<ToolGroup> {
  const groups = new Set<ToolGroup>(["core", "external"]);
  // Attachment presence is a structural fact, not semantic request routing.
  // The model selects every other capability through requestAdditionalTools.
  if (input.hasFileAttachments || input.hasImageAttachments) groups.add("discord-retrieval");
  if (input.hasImageAttachments) groups.add("image");

  return groups;
}

/** Compact deployment-aware discovery context for the model before expansion. */
export function capabilityIndexForModel(config: AppConfig): string {
  const available = normalizeGroups(new Set(TOOL_GROUPS), config);
  return [...available]
    .filter((group) => group !== "core" && group !== "external")
    .map((group) => `- ${group}: ${TOOL_GROUP_DESCRIPTIONS[group]}`)
    .join("\n");
}

export function scopedToolset(input: { config: AppConfig; groups: Set<ToolGroup> }): ScopedToolset {
  const groups = normalizeGroups(input.groups, input.config);
  const localTools = toolRegistry
    .filter((tool) =>
      groups.has(tool.group) &&
      isToolDeploymentAvailable(tool, input.config)
    )
    .map((tool) => toolForDeployment(tool, input.config));
  return {
    groups,
    localTools,
    serverTools: openRouterServerToolRegistry.filter((tool) => groups.has(tool.group)),
  };
}

export function requestAdditionalToolGroups(input: {
  requestedGroups?: string[];
  currentGroups: Set<ToolGroup>;
  config: AppConfig;
}): ScopedToolset {
  const validRequestedGroups = input.requestedGroups?.filter(isToolGroup) ?? [];
  const hasInvalidRequestedGroup = input.requestedGroups?.some((group) => !isToolGroup(group)) ?? false;
  const requested = input.requestedGroups == null
    ? normalizeGroups(new Set(TOOL_GROUPS), input.config)
    : validRequestedGroups.length > 0 && !hasInvalidRequestedGroup
      ? normalizeGroups(new Set(validRequestedGroups), input.config)
      : new Set<ToolGroup>();
  return scopedToolset({ config: input.config, groups: new Set([...input.currentGroups, ...requested]) });
}

export function isSpotifyConfigured(config: AppConfig) {
  return Boolean(config.spotify?.clientId?.trim() && config.spotify?.clientSecret?.trim());
}

export function isCodegenConfigured(config: AppConfig) {
  return missingCodegenConfig(config).length === 0;
}

export function missingCodegenConfig(config: AppConfig): string[] {
  const missing: string[] = [];
  const repository = config.github?.repository?.trim();
  if (!repository || repository === "owner/repo") missing.push("GITHUB_REPOSITORY");
  if (!hasGitHubTaskCredential(config)) missing.push("GITHUB_TOKEN (or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID)");
  if (!config.execution?.taskSigningSecret) missing.push("TASK_SIGNING_SECRET");
  return missing;
}

function normalizeGroups(groups: Set<ToolGroup>, config: AppConfig) {
  const next = new Set(groups);
  next.add("core");
  next.add("external");
  if (!isSpotifyConfigured(config)) next.delete("spotify");
  if (!isCodegenConfigured(config)) next.delete("codegen");
  return next;
}

function isToolDeploymentAvailable(tool: ToolRegistryEntry, config: AppConfig) {
  if (tool.group === "spotify") return isSpotifyConfigured(config);
  if (tool.group === "codegen") return isCodegenConfigured(config);
  if ([
    "awaitRandomWagerAction", "settleRandomWager", "transferWalletFunds", "requestStarterFunds",
    "adminTransferWalletFunds", "adminSetWalletStarterAmount", "getWalletFeeSummary",
    "reconcileWalletTransfers"
  ].includes(tool.name)) {
    return Boolean(config.payments?.walletEnabled && config.payments?.userWalletsEnabled);
  }
  if (tool.name === "getWalletBalance") return Boolean(config.payments?.walletEnabled);
  if (tool.name === "listWalletBalances" || tool.name === "getWagerHistory") return Boolean(config.payments?.walletEnabled && config.payments?.userWalletsEnabled);
  return true;
}

function isToolGroup(value: string): value is ToolGroup {
  return (TOOL_GROUPS as string[]).includes(value);
}
