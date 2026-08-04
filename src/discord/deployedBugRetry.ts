import type { Client, Message } from "discord.js";
import type { AppConfig } from "../config/env.js";
import { resolveGitHubTaskToken } from "../github/appToken.js";
import { parseGitHubRepository } from "../github/repository.js";
import type { DiscordBugReport } from "../db/repositories.js";
import { logger } from "../util/logger.js";
import { executeDiscordAgentRequest } from "./agentDelivery.js";
import { discordEdit, discordReply } from "./api.js";
import { discordChannelThreadKey } from "./mentionParsing.js";
import { fetchDiscordMessage, recordTraceEvent, type DiscordAgentRequestInput } from "./requestContext.js";
import { DiscordResponseSink } from "./responseSink.js";
import { BUG_FIX_TITLE, formatUpdateAnnouncement, generateUpdateNotes } from "./updateAnnouncements.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const DEPLOYED_BUG_RETRY_LIMIT = 20;

type GitHubPullRequest = {
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  title?: string | null;
};

type GitHubComparison = {
  status?: "ahead" | "behind" | "diverged" | "identical";
};

export type BugFixAnnouncement = { content: string; messageId: string };
type BugFixProcessResult = { announcement: BugFixAnnouncement; retried: boolean; error?: unknown };

export async function retryDeployedDiscordBugReports(input: DiscordAgentRequestInput & {
  client: Client;
  fetchImpl?: typeof fetch;
  githubToken?: string;
  processReport?: (report: DiscordBugReport, revision: string, pullRequest: GitHubPullRequest) => Promise<BugFixProcessResult>;
}) {
  const revision = input.config.appRevision?.trim();
  const repository = input.config.github.repository?.trim();
  if (!revision || revision === "unknown" || !repository || !input.agentRuntime) {
    return { eligible: 0, retried: 0, skipped: 0, bugFixAnnouncement: null };
  }
  const reports = await input.repo.listDiscordBugReportsAwaitingDeployment(DEPLOYED_BUG_RETRY_LIMIT);
  if (reports.length === 0) return { eligible: 0, retried: 0, skipped: 0, bugFixAnnouncement: null };

  const token = input.githubToken ?? await resolveGitHubTaskToken(input.config);
  const fetchImpl = input.fetchImpl ?? fetch;
  let retried = 0;
  let skipped = 0;
  let bugFixAnnouncement: BugFixAnnouncement | null = null;
  for (const report of reports) {
    let deploymentClaimed = false;
    let retryOutcome: Parameters<typeof input.repo.recordDiscordBugReportRetry>[0] | null = null;
    try {
      const deployment = await deployedPullRequest({
        config: input.config,
        report,
        revision,
        token,
        fetchImpl,
      });
      if (!deployment) {
        skipped += 1;
        continue;
      }
      const claimed = await input.repo.claimDiscordBugReportDeployment({
        reportId: report.reportId,
        mergeCommitSha: deployment.mergeCommitSha,
        deployedRevision: revision,
      });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      deploymentClaimed = true;
      const result = await (input.processReport
        ? input.processReport(report, revision, deployment.pullRequest)
        : postBugFixUpdateAndRetry(input, report, revision, deployment.pullRequest));
      retryOutcome = {
        reportId: report.reportId,
        status: result.retried ? "succeeded" : "failed",
        retryExecutionId: `bug-retry-${report.reportId}`,
        announcementMessageId: result.announcement.messageId,
      };
      await persistRetryOutcome(input.repo, retryOutcome, revision);
      bugFixAnnouncement ??= result.announcement;
      if (result.retried) {
        retried += 1;
      } else {
        skipped += 1;
        logger.warn({ err: result.error, reportId: report.reportId, revision }, "Posted a bug-fix update but failed to retry the original Discord prompt");
      }
    } catch (error) {
      if (deploymentClaimed) {
        await input.repo.recordDiscordBugReportRetry(retryOutcome ?? {
          reportId: report.reportId,
          status: "failed",
          retryExecutionId: `bug-retry-${report.reportId}`,
        }).catch(() => undefined);
      }
      skipped += 1;
      logger.warn({ err: error, reportId: report.reportId, revision }, "Failed to retry a deployed Discord bug report");
    }
  }
  return { eligible: reports.length, retried, skipped, bugFixAnnouncement };
}

async function persistRetryOutcome(
  repo: DiscordAgentRequestInput["repo"],
  outcome: Parameters<DiscordAgentRequestInput["repo"]["recordDiscordBugReportRetry"]>[0],
  revision: string,
) {
  try {
    await repo.recordDiscordBugReportRetry(outcome);
  } catch (error) {
    logger.warn({ err: error, reportId: outcome.reportId, revision }, "Failed to persist a Discord bug retry outcome; retrying once");
    await repo.recordDiscordBugReportRetry(outcome).catch((retryError) => {
      logger.warn({ err: retryError, reportId: outcome.reportId, revision }, "Could not persist the Discord bug retry outcome");
    });
  }
}

async function deployedPullRequest(input: {
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
  if (sameRevision(mergeCommitSha, input.revision)) return { mergeCommitSha, pullRequest };
  const comparison = await githubJson<GitHubComparison>(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/compare/${encodeURIComponent(mergeCommitSha)}...${encodeURIComponent(input.revision)}`,
    input.token,
    input.fetchImpl,
  );
  return comparison.status === "ahead" || comparison.status === "identical" ? { mergeCommitSha, pullRequest } : null;
}

async function postBugFixUpdateAndRetry(
  input: DiscordAgentRequestInput & { client: Client },
  report: DiscordBugReport,
  revision: string,
  pullRequest: GitHubPullRequest,
): Promise<BugFixProcessResult> {
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
  const fallback = fallbackBugFixNote(pullRequest.title, report.summary);
  const generated = await generateUpdateNotes({
    openRouter: input.openRouter,
    config: input.config,
    evidence: bugFixEvidence(pullRequest.title, report.summary),
    maxBullets: 1,
    fallback,
  }).catch((error) => {
    logger.warn({ err: error, reportId: report.reportId, revision }, "Bug-fix update model call failed; using the validated summary fallback");
    return { body: fallback, model: null, estimatedCostUsd: null };
  });
  const content = formatUpdateAnnouncement({
    body: generated.body,
    repository: input.config.github.repository,
    base: report.sourceRevision,
    head: revision,
    title: BUG_FIX_TITLE,
  });
  const announcementMessage = await postBugFixUpdate(original as Message, markedReply as Message, content);
  const announcement = { content, messageId: announcementMessage.id };

  if (report.taskId) {
    await input.repo.markAgentTaskRendered({
      taskId: report.taskId,
      signature: JSON.stringify({ deployedBugFixUpdate: revision, reportId: report.reportId }),
      terminal: true,
    }).catch((error) => logger.warn({ err: error, reportId: report.reportId }, "Failed to mark the bug-report task rendered after posting its update"));
  }
  await input.repo.auditTool({
    traceId: retryRequestId,
    guildId: report.guildId,
    channelId: report.channelId,
    toolName: "bugFixPatchNotes",
    argumentsSummary: `${report.sourceRevision.slice(0, 7)}...${revision.slice(0, 7)}`,
    resultSummary: `Posted bug-fix update ${announcementMessage.id}`,
    model: generated.model,
    estimatedCostUsd: generated.estimatedCostUsd,
  }).catch((error) => logger.warn({ err: error, reportId: report.reportId }, "Failed to record bug-fix update audit"));
  await recordTraceEvent(input.repo, {
    traceId: retryRequestId,
    requestId: retryRequestId,
    guildId: report.guildId,
    channelId: report.channelId,
    userId: execution.userId,
    eventName: "discord.bug_report.update_posted",
    summary: "Posted the deployed bug-fix update beside the original request.",
    metadata: {
      reportId: report.reportId,
      sourceRevision: report.sourceRevision,
      deployedRevision: revision,
      updateMessageId: announcementMessage.id,
      reusedMarkedReply: announcementMessage.id === markedReply.id,
    },
  });

  const threadKey = discordChannelThreadKey(report.guildId, report.channelId);
  await input.repo.deleteConversationMessagesByDiscordMessageIds({
    threadKey,
    discordMessageIds: [original.id, markedReply.id],
  }).catch((error) => logger.warn({ err: error, reportId: report.reportId }, "Failed to clear stale bug-report conversation memory before retry"));
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
      updateMessageId: announcementMessage.id,
    },
  });

  const responseSink = new DiscordResponseSink({
    client: input.client,
    sourceMessage: original as Message,
    maxReplyChars: input.config.maxReplyChars,
    logger: logger.child({ reportId: report.reportId, requestId: retryRequestId }),
    loadingReactionEmoji: input.config.discord.loadingReaction,
    deliveryKey: retryRequestId,
  });
  try {
    await executeDiscordAgentRequest(input, input.client, original as Message, responseSink, {
      requestId: retryRequestId,
      text: execution.request,
      rawContent: original.content,
      botRoleIds: [],
      messageStartedAt: Date.now(),
      userId: execution.userId,
      userDisplayName: original.member?.displayName ?? original.author.username,
    });
    await recordTraceEvent(input.repo, {
      traceId: retryRequestId,
      requestId: retryRequestId,
      guildId: report.guildId,
      channelId: report.channelId,
      userId: execution.userId,
      eventName: "discord.bug_report.retry_completed",
      summary: "Retried the original Discord prompt in a fresh reply after posting its bug-fix update.",
      metadata: { reportId: report.reportId, deployedRevision: revision, updateMessageId: announcementMessage.id },
    });
    return { announcement, retried: true };
  } catch (error) {
    await recordTraceEvent(input.repo, {
      traceId: retryRequestId,
      requestId: retryRequestId,
      guildId: report.guildId,
      channelId: report.channelId,
      userId: execution.userId,
      eventName: "discord.bug_report.retry_failed",
      level: "error",
      summary: error instanceof Error ? error.message : String(error),
      metadata: { reportId: report.reportId, deployedRevision: revision, updateMessageId: announcementMessage.id },
    });
    return { announcement, retried: false, error };
  }
}

async function postBugFixUpdate(original: Message, markedReply: Message, content: string): Promise<Message> {
  if (markedReply.reference?.messageId === original.id) {
    const edited = await discordEdit(markedReply, { content, allowedMentions: { parse: [] } }, { logger });
    if (edited.ok) return edited.value;
    if (edited.reason !== "unknown_message") throw edited.error;
  }
  const replied = await discordReply(original, {
    content,
    allowedMentions: { parse: [], repliedUser: false },
  }, { logger });
  if (!replied.ok) throw replied.error;
  return replied.value;
}

function bugFixEvidence(title: string | null | undefined, summary: string | null) {
  return [
    `Bug-fix title: ${title?.trim() || "Untitled bug fix"}`,
    `Validated outcome: ${summary?.trim() || "The reported behavior was confirmed and fixed."}`,
  ].join("\n");
}

function fallbackBugFixNote(title: string | null | undefined, summary: string | null) {
  const source = title?.trim() || summary?.trim() || "Small reliability fix";
  return `- ${source.replace(/^(?:fix|fixed|bugfix)(?:\([^)]+\))?!?:\s*/i, "").split("\n")[0]!.slice(0, 280)}`;
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

export const __test = {
  bugFixEvidence,
  fallbackBugFixNote,
  postBugFixUpdate,
};
