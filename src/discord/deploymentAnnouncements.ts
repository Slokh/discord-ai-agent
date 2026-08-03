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
  "markDeploymentAnnouncementPosted" | "markDeploymentAnnouncementFailed" | "recordTraceEvent" | "auditTool"
>;

export async function announceDeployment(input: {
  client: Client;
  config: AppConfig;
  repo: AnnouncementRepository;
  openRouter: Pick<OpenRouterClient, "chat">;
  fetchImpl?: typeof fetch;
  deliveredBugFix?: { content: string; messageId: string } | null;
}): Promise<"disabled" | "baseline" | "duplicate" | "posted" | "bug_fix"> {
  const { config, repo } = input;
  const guildId = config.discord.guildId;
  const channelId = config.releaseNotes.channelId;
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
    if (input.deliveredBugFix) {
      await repo.markDeploymentAnnouncementPosted({
        guildId,
        revision,
        content: input.deliveredBugFix.content,
        comparisonUrl,
        discordMessageId: input.deliveredBugFix.messageId,
      });
      await recordEvent(repo, {
        traceId,
        guildId,
        channelId,
        eventName: "deployment.bug_fix_announcement.posted",
        summary: "Recorded the deployed bug-fix update posted beside the original request.",
        metadata: { previousRevision, revision, messageId: input.deliveredBugFix.messageId, comparisonUrl }
      });
      return "bug_fix";
    }

    const channel = await input.client.channels.fetch(channelId);
    if (!channel || typeof (channel as any).send !== "function") {
      throw new Error(`Release notes channel ${channelId} is missing or is not message-capable.`);
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

    const comparison = await fetchGitHubComparison(config, previousRevision, revision, input.fetchImpl ?? fetch);
    await recordEvent(repo, {
      traceId,
      guildId,
      channelId,
      eventName: "deployment.compare.loaded",
      summary: `Loaded ${comparison.commits?.length ?? 0} commits and ${comparison.files?.length ?? 0} changed files.`,
      metadata: { previousRevision, revision, status: comparison.status, aheadBy: comparison.ahead_by }
    });

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
    await recordEvent(repo, {
      traceId,
      guildId,
      channelId,
      eventName: "deployment.announcement.posted",
      summary: "Posted deployment patch notes.",
      metadata: { previousRevision, revision, messageId: sent.value.id, comparisonUrl }
    });
    return "posted";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repo.markDeploymentAnnouncementFailed({ guildId, revision, error: message })
      .catch((recordError) => logger.warn({ err: recordError, revision }, "Failed to persist deployment announcement failure"));
    await recordEvent(repo, {
      traceId,
      guildId,
      channelId,
      eventName: "deployment.announcement.failed",
      level: "error",
      summary: message,
      metadata: { previousRevision, revision }
    });
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
  if (!titles.length) return "- Small behind-the-scenes reliability update.";
  return titles.map((title) => `- ${title.replace(/^[-*]\s*/, "").slice(0, 240)}`).join("\n");
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

async function recordEvent(repo: AnnouncementRepository, input: Parameters<AnnouncementRepository["recordTraceEvent"]>[0]) {
  await repo.recordTraceEvent(input).catch((error) => logger.warn({ err: error }, "Failed to record deployment announcement trace event"));
}

export const __test = {
  comparisonEvidence,
  fallbackPatchNotes,
  formatAnnouncement,
  normalizePatchNotes: normalizeUpdateNotes
};
