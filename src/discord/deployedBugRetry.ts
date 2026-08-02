import type { Client, Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import { resolveGitHubTaskToken } from "../github/appToken.js";
import { parseGitHubRepository } from "../github/repository.js";
import type { DiscordBugReport } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { executeDiscordAgentRequest } from "./agentDelivery.js";
import { discordChannelThreadKey } from "./mentionParsing.js";
import { fetchDiscordMessage, recordTraceEvent, type DiscordAgentRequestInput } from "./requestContext.js";
import { DiscordResponseSink } from "./responseSink.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const DEPLOYED_BUG_RETRY_LIMIT = 20;

type GitHubPullRequest = {
  merged_at?: string | null;
  merge_commit_sha?: string | null;
};

type GitHubComparison = {
  status?: "ahead" | "behind" | "diverged" | "identical";
};

export async function retryDeployedDiscordBugReports(input: DiscordAgentRequestInput & {
  client: Client;
  fetchImpl?: typeof fetch;
  githubToken?: string;
  retryPrompt?: (report: DiscordBugReport, revision: string) => Promise<void>;
}) {
  const revision = input.config.appRevision?.trim();
  const repository = input.config.github.repository?.trim();
  if (!revision || revision === "unknown" || !repository || !input.agentRuntime) {
    return { eligible: 0, retried: 0, skipped: 0 };
  }
  const reports = await input.repo.listDiscordBugReportsAwaitingDeployment(DEPLOYED_BUG_RETRY_LIMIT);
  if (reports.length === 0) return { eligible: 0, retried: 0, skipped: 0 };

  const token = input.githubToken ?? await resolveGitHubTaskToken(input.config);
  const fetchImpl = input.fetchImpl ?? fetch;
  let retried = 0;
  let skipped = 0;
  for (const report of reports) {
    try {
      const mergeCommitSha = await deployedMergeCommit({
        config: input.config,
        report,
        revision,
        token,
        fetchImpl,
      });
      if (!mergeCommitSha) {
        skipped += 1;
        continue;
      }
      const claimed = await input.repo.claimDiscordBugReportDeployment({
        reportId: report.reportId,
        mergeCommitSha,
        deployedRevision: revision,
      });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      await (input.retryPrompt
        ? input.retryPrompt(report, revision)
        : retryOriginalDiscordPrompt(input, report, revision));
      retried += 1;
    } catch (error) {
      skipped += 1;
      logger.warn({ err: error, reportId: report.reportId, revision }, "Failed to retry a deployed Discord bug report");
    }
  }
  return { eligible: reports.length, retried, skipped };
}

async function deployedMergeCommit(input: {
  config: AppConfig;
  report: DiscordBugReport;
  revision: string;
  token: string;
  fetchImpl: typeof fetch;
}) {
  const target = parsePullRequestUrl(input.report.prUrl);
  if (!target) return null;
  const configured = parseGitHubRepository(input.config.github.repository);
  if (target.owner.toLowerCase() !== configured.owner.toLowerCase() || target.repo.toLowerCase() !== configured.repo.toLowerCase()) {
    return null;
  }
  const pullRequest = await githubJson<GitHubPullRequest>(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.number}`,
    input.token,
    input.fetchImpl,
  );
  const mergeCommitSha = pullRequest.merged_at && pullRequest.merge_commit_sha?.trim();
  if (!mergeCommitSha) return null;
  if (sameRevision(mergeCommitSha, input.revision)) return mergeCommitSha;
  const comparison = await githubJson<GitHubComparison>(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/compare/${encodeURIComponent(mergeCommitSha)}...${encodeURIComponent(input.revision)}`,
    input.token,
    input.fetchImpl,
  );
  return comparison.status === "ahead" || comparison.status === "identical" ? mergeCommitSha : null;
}

async function retryOriginalDiscordPrompt(
  input: DiscordAgentRequestInput & { client: Client },
  report: DiscordBugReport,
  revision: string,
) {
  const execution = await input.repo.findAgentRuntimeChatExecutionByTraceId(report.sourceMessageId);
  if (!execution?.traceId || !execution.userId || !execution.guildId || !execution.channelId || !execution.request.trim()) {
    throw new Error("The original Discord execution is incomplete and cannot be retried.");
  }
  const [original, markedReply] = await Promise.all([
    fetchDiscordMessage(input.client, execution.channelId, execution.traceId),
    fetchDiscordMessage(input.client, report.channelId, report.sourceMessageId),
  ]);
  if (!original.inGuild() || !markedReply.inGuild() || original.guildId !== report.guildId || original.author.id !== execution.userId) {
    throw new Error("The original Discord requester or guild no longer matches the retained execution.");
  }

  const retryRequestId = `bug-retry-${report.reportId}`;
  const threadKey = discordChannelThreadKey(report.guildId, report.channelId);
  await input.repo.deleteConversationMessagesByDiscordMessageIds({
    threadKey,
    discordMessageIds: [original.id, markedReply.id],
  });
  await recordTraceEvent(input.repo, {
    traceId: retryRequestId,
    requestId: retryRequestId,
    guildId: report.guildId,
    channelId: report.channelId,
    userId: execution.userId,
    eventName: "discord.bug_report.retry_started",
    summary: "Retrying the original Discord prompt after its fix reached production.",
    metadata: {
      reportId: report.reportId,
      sourceExecutionId: report.sourceExecutionId,
      sourceRevision: report.sourceRevision,
      deployedRevision: revision,
      replacedReplyMessageId: markedReply.id,
    },
  });

  const responseSink = new DiscordResponseSink({
    client: input.client,
    sourceMessage: original as Message,
    maxReplyChars: input.config.maxReplyChars,
    logger: logger.child({ reportId: report.reportId, requestId: retryRequestId }),
    loadingReactionEmoji: input.config.discord.loadingReaction,
    statusMessage: markedReply as Message,
    deliveryKey: retryRequestId,
    silentUntilFinal: true,
  });
  await executeDiscordAgentRequest(input, input.client, original as Message, responseSink, {
    requestId: retryRequestId,
    text: execution.request,
    rawContent: original.content,
    botRoleIds: [],
    messageStartedAt: Date.now(),
    userId: execution.userId,
    userDisplayName: original.member?.displayName ?? original.author.username,
  });
  if (report.taskId) {
    await input.repo.markAgentTaskRendered({
      taskId: report.taskId,
      signature: JSON.stringify({ deployedBugRetry: revision, reportId: report.reportId }),
      terminal: true,
    });
  }
  await recordTraceEvent(input.repo, {
    traceId: retryRequestId,
    requestId: retryRequestId,
    guildId: report.guildId,
    channelId: report.channelId,
    userId: execution.userId,
    eventName: "discord.bug_report.retry_completed",
    summary: "Retried the original Discord prompt and replaced the marked reply.",
    metadata: { reportId: report.reportId, deployedRevision: revision, replacedReplyMessageId: markedReply.id },
  });
}

function parsePullRequestUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (url.hostname.toLowerCase() !== "github.com" || !match) return null;
    return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
  } catch {
    return null;
  }
}

async function githubJson<T>(path: string, token: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${GITHUB_API_BASE_URL}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} while resolving a deployed bug fix.`);
  return await response.json() as T;
}

function sameRevision(left: string, right: string) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a === b || (a.length >= 7 && b.startsWith(a)) || (b.length >= 7 && a.startsWith(b));
}
