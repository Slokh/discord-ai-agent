import { hasGitHubTaskCredential, type AppConfig } from "../config/env.js";
import {
  openRouterServerToolRegistry,
  toolRegistry,
  type OpenRouterServerToolRegistryEntry,
  type ToolGroup,
  type ToolRegistryEntry,
} from "./registry.js";

export type ToolScopeInput = {
  text: string;
  hasImageAttachments: boolean;
  config: AppConfig;
  replyContext?: boolean;
};

export type ScopedToolset = {
  groups: Set<ToolGroup>;
  localTools: ToolRegistryEntry[];
  serverTools: OpenRouterServerToolRegistryEntry[];
};

const ALL_GROUPS: ToolGroup[] = [
  "core",
  "discord-retrieval",
  "generated-data",
  "discord-action",
  "image",
  "spotify",
  "codegen",
  "ops",
  "external",
];

export function selectToolGroups(input: ToolScopeInput): Set<ToolGroup> {
  const text = input.text.toLowerCase();
  const groups = new Set<ToolGroup>(["core", "external"]);

  if (hasAny(text, DISCORD_RETRIEVAL_KEYWORDS)) groups.add("discord-retrieval");
  if (hasAny(text, GENERATED_DATA_KEYWORDS)) groups.add("generated-data");
  if (hasAny(text, DISCORD_ACTION_KEYWORDS)) groups.add("discord-action");
  if (input.hasImageAttachments || hasAny(text, IMAGE_KEYWORDS)) groups.add("image");
  if (isSpotifyConfigured(input.config) && hasAny(text, SPOTIFY_KEYWORDS)) groups.add("spotify");
  if (isCodegenConfigured(input.config) && hasAny(text, CODEGEN_KEYWORDS)) groups.add("codegen");
  if (hasAny(text, OPS_KEYWORDS)) groups.add("ops");

  return groups;
}

export function scopedToolset(input: { config: AppConfig; groups: Set<ToolGroup> }): ScopedToolset {
  const groups = normalizeGroups(input.groups, input.config);
  return {
    groups,
    localTools: toolRegistry.filter((tool) =>
      (groups.has(tool.group) || tool.name === "drawRandom") &&
      isToolDeploymentAvailable(tool, input.config)
    ),
    serverTools: openRouterServerToolRegistry.filter((tool) => groups.has(tool.group)),
  };
}

export function requestAdditionalToolGroups(input: {
  requestedGroups?: string[];
  currentGroups: Set<ToolGroup>;
  config: AppConfig;
}): ScopedToolset {
  const requested = input.requestedGroups?.length
    ? normalizeGroups(new Set(input.requestedGroups.filter(isToolGroup)), input.config)
    : normalizeGroups(new Set(ALL_GROUPS), input.config);
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
  return true;
}

function isToolGroup(value: string): value is ToolGroup {
  return (ALL_GROUPS as string[]).includes(value);
}

function hasAny(text: string, keywords: RegExp[]) {
  return keywords.some((keyword) => keyword.test(text));
}

const IMAGE_KEYWORDS = [
  /\b(generate|draw|paint|sketch|illustrate|make|create)\b.*\b(image|picture|pic|photo|avatar|pfp|logo|poster|meme|art)\b/,
  /\b(image|picture|pic|photo|screenshot|avatar|pfp|meme|chart|diagram|logo)\b/,
  /\b(draw|paint|sketch|illustrate)\b/,
  /\bwhat('| i)?s (in|on|shown)\b/,
  /\blook at this\b/,
];

const DISCORD_RETRIEVAL_KEYWORDS = [
  /\b(discord|server|channel|thread|message|messages|history|recent|recap|summary|summarize|stats|ranking|reactions?|attachments?)\b/,
  /\b(who|what)\b.*\b(said|posted|mentioned|talked|happened|did)\b/,
  /\b(yesterday|today|this week|last week|past month|recently)\b/,
  /discord(?:app)?\.com\/channels\//,
  /<[@#][!&]?\d+>/,
];

const GENERATED_DATA_KEYWORDS = [
  /\b(csv|table|spreadsheet|generated file|generated result|download|rows?|columns?)\b/,
  /\b(that|the|previous|earlier)\b.*\b(file|list|result|table|csv)\b/,
];

const DISCORD_ACTION_KEYWORDS = [
  /\b(poll|vote|undo|delete your|remove your|forget your)\b/,
  /\b(random|randomly|roll|dice|coin flip|pick one|choose one|shuffle|draw)\b/,
  /\b(reveal)\b.*\b(random|seed|proof|commitment)\b/,
];

const SPOTIFY_KEYWORDS = [
  /\bspotify\b/,
  /open\.spotify\.com/,
  /\b(music|song|track|playlist|artist|album|discography|listen|listening|played|play)\b/,
];

const CODEGEN_KEYWORDS = [
  /\b(fix|debug|change|update|edit|implement|add|remove|refactor|ship|deploy|pr|pull request)\b.*\b(bot|code|repo|repository|github|ci|test|feature|bug|app|worker)\b/,
  /\b(bot|code|repo|repository|github|ci|test|feature|bug|app|worker)\b.*\b(fix|debug|change|update|edit|implement|add|remove|refactor|ship|deploy|pr|pull request)\b/,
  /\bmake (the|this|our) bot\b/,
  /\bopen a pr\b/,
];

const OPS_KEYWORDS = [
  /\b(status|health|logs?|trace|why.*(failed|slow|hung)|deployment|config|admin|ops)\b/,
  /\b(bot avatar|avatar|profile picture|pfp)\b/,
  /\bwhat can you do\b/,
  /\b(rate.?limit|turn limit|post limit|unlimit)\b/,
  /\blimit\b.*\b(per day|daily|posts?|turns?|messages?|uses?)\b/,
];
