import type { Client } from "discord.js";
import type { AppConfig } from "../config/env.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { resolveGitHubTaskToken } from "../github/appToken.js";
import { parseGitHubRepository } from "../github/repository.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { logger } from "../util/logger.js";
import { discordSend } from "./api.js";
import {
  formatUpdateAnnouncement,
  generateUpdateNotes,
  githubComparisonUrl,
  normalizeUpdateNotes,
  updateNotesLookComplete,
} from "./updateAnnouncements.js";

type CompareCommit = { sha?: string; commit?: { message?: string } };
type CompareFile = { filename?: string; status?: string; additions?: number; deletions?: number; patch?: string };
type GitHubCompare = {
  html_url?: string;
  status?: string;
  ahead_by?: number;
  commits?: CompareCommit[];
  files?: CompareFile[];
};

type AnnouncementRepository = Pick<DiscordAiAgentRepository,
  "claimDeploymentAnnouncement" | "recordDeploymentBaseline" | "latestDeploymentRevision" |
  "markDeploymentAnnouncementPosted" | "markDeploymentAnnouncementFailed" | "markDeploymentAnnouncementSkipped" | "auditTool"
>;

export async function announceDeployment(input: {
  client: Client;
  config: AppConfig;
  repo: AnnouncementRepository;
  openRouter: Pick<OpenRouterClient, "chat">;
  fetchImpl?: typeof fetch;
}): Promise<"disabled" | "baseline" | "duplicate" | "posted" | "skipped"> {
  const { config, repo } = input;
  const guildId = config.discord.guildId;
  const channelId = config.discord.botChannelId;
  const revision = config.appRevision;
  if (!guildId || !channelId || !isDeployRevision(revision)) return "disabled";

  const previousRevision = config.releaseNotes.previousRevision ?? await repo.latestDeploymentRevision(guildId);
  if (!previousRevision) {
    await repo.recordDeploymentBaseline({ guildId, revision, repository: config.github.repository, channelId });
    return "baseline";
  }
  if (previousRevision === revision) return "duplicate";

  const claimed = await repo.claimDeploymentAnnouncement({
    guildId,
    revision,
    previousRevision,
    repository: config.github.repository,
    channelId
  });
  if (!claimed) return "duplicate";

  const traceId = `deployment:${revision}`;
  try {
    const comparisonUrl = githubComparisonUrl(config.github.repository, previousRevision, revision);
    const comparison = await fetchGitHubComparison(config, previousRevision, revision, input.fetchImpl ?? fetch);
    if (isConsoleOnlyComparison(comparison)) {
      await repo.markDeploymentAnnouncementSkipped({ guildId, revision, comparisonUrl });
      return "skipped";
    }
    const channel = await input.client.channels.fetch(channelId);
    if (!channel || typeof (channel as any).send !== "function") {
      throw new Error(`Bot channel ${channelId} is missing or is not message-capable.`);
    }

    const existing = await findExistingAnnouncement(channel as any, revision);
    if (existing) {
      await repo.markDeploymentAnnouncementPosted({
        guildId,
        revision,
        content: String(existing.content ?? ""),
        comparisonUrl,
        discordMessageId: String(existing.id)
      });
      return "duplicate";
    }

    const generated = await generatePatchNotes(input.openRouter, config, comparison).catch((error) => {
      logger.warn({ err: error, revision }, "Patch-note model call failed; using commit-summary fallback");
      return { body: fallbackPatchNotes(comparison), model: null, estimatedCostUsd: null };
    });
    const content = formatAnnouncement(generated.body, config.github.repository, previousRevision, revision);
    const sent = await discordSend(channel as any, {
      content,
      allowedMentions: { parse: [] }
    }, { logger });
    if (!sent.ok) throw new Error(`Discord release-note send failed: ${sent.reason}`);

    await repo.markDeploymentAnnouncementPosted({
      guildId,
      revision,
      content,
      comparisonUrl,
      discordMessageId: sent.value.id
    });
    await repo.auditTool({
      traceId,
      guildId,
      channelId,
      toolName: "deploymentPatchNotes",
      argumentsSummary: `${previousRevision.slice(0, 7)}...${revision.slice(0, 7)}`,
      resultSummary: `Posted deployment notes to ${channelId}`,
      model: generated.model,
      estimatedCostUsd: generated.estimatedCostUsd
    }).catch((error) => logger.warn({ err: error, revision }, "Failed to record deployment announcement audit"));
    return "posted";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repo.markDeploymentAnnouncementFailed({ guildId, revision, error: message })
      .catch((recordError) => logger.warn({ err: recordError, revision }, "Failed to persist deployment announcement failure"));
    throw error;
  }
}

async function fetchGitHubComparison(config: AppConfig, base: string, head: string, fetchImpl: typeof fetch): Promise<GitHubCompare> {
  const { owner, repo } = parseGitHubRepository(config.github.repository);
  const token = await optionalGitHubToken(config);
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "discord-ai-agent",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }
  );
  if (!response.ok) throw new Error(`GitHub compare failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return await response.json() as GitHubCompare;
}

async function optionalGitHubToken(config: AppConfig) {
  const hasApp = config.github.appId && config.github.appPrivateKey && config.github.appInstallationId;
  if (!config.github.token && !hasApp) return null;
  return resolveGitHubTaskToken(config);
}

async function generatePatchNotes(openRouter: Pick<OpenRouterClient, "chat">, config: AppConfig, comparison: GitHubCompare) {
  const evidence = comparisonEvidence(comparison);
  return generateUpdateNotes({
    openRouter,
    config,
    evidence,
    maxBullets: 5,
    fallback: fallbackPatchNotes(comparison),
  });
}

function comparisonEvidence(comparison: GitHubCompare): string {
  const commits = (comparison.commits ?? []).slice(0, 50).map((entry) =>
    `- ${(entry.commit?.message ?? "Untitled change").split("\n")[0]?.slice(0, 240)}`
  );
  const files = (comparison.files ?? []).slice(0, 50).map((file) => {
    const patch = file.patch?.replace(/\s+/g, " ").slice(0, 500);
    return `- ${file.status ?? "changed"}: ${file.filename ?? "unknown"} (+${file.additions ?? 0}/-${file.deletions ?? 0})${patch ? ` | ${patch}` : ""}`;
  });
  return [
    `Compare status: ${comparison.status ?? "unknown"}; commits ahead: ${comparison.ahead_by ?? commits.length}`,
    "Commit summaries:",
    ...(commits.length ? commits : ["- No commit summaries returned"]),
    "Changed files and bounded diff excerpts:",
    ...(files.length ? files : ["- No files returned"])
  ].join("\n").slice(0, 24_000);
}

function fallbackPatchNotes(comparison: GitHubCompare): string {
  const titles = (comparison.commits ?? [])
    .map((entry) => (entry.commit?.message ?? "").split("\n")[0]?.trim())
    .filter((title): title is string => Boolean(title))
    .filter((title) => !/^merge (pull request|branch)\b/i.test(title))
    .map((title) => title.replace(/^(?:feat|fix|chore|refactor|docs|test|build|ci|perf)(?:\([^)]+\))?!?:\s*/i, ""))
    .slice(0, 5);
  if (titles.length) return titles.map((title) => `- ${title.replace(/^[-*]\s*/, "").slice(0, 240)}`).join("\n");

  const files = (comparison.files ?? [])
    .filter((file) => Boolean(file.filename))
    .slice(0, 5)
    .map((file) => `- ${file.status ?? "Changed"} ${file.filename} (+${file.additions ?? 0}/-${file.deletions ?? 0}).`);
  if (files.length) return files.join("\n");

  return "- GitHub returned no commit or file details for this deployment.";
}

function formatAnnouncement(body: string, repository: string, base: string, head: string): string {
  return formatUpdateAnnouncement({ body, repository, base, head });
}

async function findExistingAnnouncement(channel: any, revision: string): Promise<any | null> {
  if (typeof channel.messages?.fetch !== "function") return null;
  const messages = await channel.messages.fetch({ limit: 25 }).catch((error: unknown) => {
    logger.warn({ err: error, revision }, "Could not check the release-notes channel for an existing announcement");
    return null;
  });
  if (!messages?.find) return null;
  const marker = `/compare/`;
  const headMarker = `...${encodeURIComponent(revision)}`;
  return messages.find((message: any) =>
    message.author?.id === channel.client?.user?.id &&
    String(message.content ?? "").includes(marker) &&
    String(message.content ?? "").includes(headMarker)
  ) ?? null;
}

function isDeployRevision(value: string) {
  return value !== "unknown" && /^[a-f0-9]{7,64}$/i.test(value);
}

/** Console and operator-ledger changes are private; their deploys are not community announcements. */
export function isConsoleOnlyComparison(comparison: GitHubCompare) {
  const files = (comparison.files ?? []).map((file) => file.filename?.trim()).filter((file): file is string => Boolean(file));
  return files.length > 0 && files.every(isConsoleOnlyFile);
}

function isConsoleOnlyFile(filename: string) {
  return filename.startsWith("src/console/")
    || filename === "src/db/operatorDashboardRepository.ts"
    || filename === "src/db/operatorActivityDetailRepository.ts"
    || filename === "src/db/serviceHeartbeatRepository.ts"
    || filename === "scripts/operatorConsole.ts"
    || /^migrations\/\d+_(?:console|service_runtime_heartbeats)/.test(filename)
    || filename.startsWith("tests/")
    || filename.startsWith("docs/")
    || filename === "README.md"
    || filename === "package-lock.json";
}

export const __test = {
  comparisonEvidence,
  fallbackPatchNotes,
  formatAnnouncement,
  isConsoleOnlyComparison,
  normalizePatchNotes: normalizeUpdateNotes,
  patchNotesLookComplete: updateNotesLookComplete,
};
