import type { AppConfig } from "../config/env.js";
import type { ImprovementPullRequestSnapshot } from "../db/types.js";
import { resolveGitHubTaskToken } from "./appToken.js";
import { parseGitHubRepository } from "./repository.js";

type GitHubPullRequestResponse = {
  node_id?: string;
  number?: number;
  state?: string;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  merged?: boolean;
  merged_at?: string | null;
  html_url?: string;
  merge_commit_sha?: string | null;
  head?: { sha?: string };
  base?: { repo?: { full_name?: string } };
};

type GitHubPullRequestPromotionResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        id?: string;
        isDraft?: boolean;
        mergeable?: string;
        mergeStateStatus?: string;
        reviewDecision?: string | null;
        autoMergeRequest?: { enabledAt?: string } | null;
        reviewThreads?: {
          nodes?: Array<{ isResolved?: boolean } | null>;
          pageInfo?: { hasNextPage?: boolean };
        };
        commits?: {
          nodes?: Array<{ commit?: { oid?: string; statusCheckRollup?: { state?: string } | null } } | null>;
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

export function parseGitHubPullRequestUrl(value: string) {
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "github.com") throw new Error("Pull request URL must use github.com.");
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) throw new Error("Pull request URL must look like https://github.com/owner/repo/pull/123.");
  return { owner: match[1]!, repo: match[2]!, pullRequestNumber: Number(match[3]) };
}

export async function fetchGitHubPullRequestSnapshot(
  config: AppConfig,
  pullRequestUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImprovementPullRequestSnapshot> {
  const parsed = parseGitHubPullRequestUrl(pullRequestUrl);
  const configured = parseGitHubRepository(config.github.repository);
  const requestedRepository = `${parsed.owner}/${parsed.repo}`;
  const configuredRepository = `${configured.owner}/${configured.repo}`;
  if (requestedRepository.toLowerCase() !== configuredRepository.toLowerCase()) {
    throw new Error(`Pull request repository ${requestedRepository} does not match configured repository ${configuredRepository}.`);
  }
  const token = await resolveGitHubTaskToken(config);
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.pullRequestNumber}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "discord-ai-agent",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub pull request lookup failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const pullRequest = await response.json() as GitHubPullRequestResponse;
  if (pullRequest.number !== parsed.pullRequestNumber || !pullRequest.head?.sha) {
    throw new Error("GitHub returned an incomplete or mismatched pull request.");
  }
  const apiRepository = pullRequest.base?.repo?.full_name;
  if (apiRepository && apiRepository.toLowerCase() !== configuredRepository.toLowerCase()) {
    throw new Error(`GitHub returned pull request data for unexpected repository ${apiRepository}.`);
  }
  const merged = pullRequest.merged === true || Boolean(pullRequest.merged_at);
  const state: ImprovementPullRequestSnapshot["state"] = merged ? "merged" : pullRequest.state === "open" ? "open" : "closed";
  if (state === "merged" && !pullRequest.merge_commit_sha) throw new Error("Merged pull request is missing its merge revision.");
  return {
    repository: configuredRepository.toLowerCase(),
    pullRequestNumber: parsed.pullRequestNumber,
    pullRequestUrl: pullRequest.html_url ?? pullRequestUrl,
    state,
    headRevision: pullRequest.head.sha,
    mergeRevision: pullRequest.merge_commit_sha ?? null,
    mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
    nodeId: pullRequest.node_id ?? null,
    draft: pullRequest.draft ?? false,
    mergeable: pullRequest.mergeable === true ? "mergeable" : pullRequest.mergeable === false ? "conflicting" : "unknown",
    mergeStateStatus: pullRequest.mergeable_state ?? null,
  };
}

/** Adds check, review, and auto-merge state needed by the durable promotion controller. */
export async function fetchGitHubPullRequestPromotionSnapshot(
  config: AppConfig,
  pullRequestUrl: string,
  fetchImpl: typeof fetch = fetch,
) {
  const snapshot = await fetchGitHubPullRequestSnapshot(config, pullRequestUrl, fetchImpl);
  if (snapshot.state !== "open") return snapshot;
  const parsed = parseGitHubPullRequestUrl(pullRequestUrl);
  const token = await resolveGitHubTaskToken(config);
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "discord-ai-agent",
    },
    body: JSON.stringify({
      query: `query ImprovementPullRequestPromotion($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            id isDraft mergeable mergeStateStatus reviewDecision
            autoMergeRequest { enabledAt }
            reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }
            commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
          }
        }
      }`,
      variables: { owner: parsed.owner, repo: parsed.repo, number: parsed.pullRequestNumber },
    }),
  });
  if (!response.ok) throw new Error(`GitHub pull request promotion lookup failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json() as GitHubPullRequestPromotionResponse;
  if (payload.errors?.length) throw new Error(`GitHub pull request promotion lookup failed: ${payload.errors.map((error) => error.message).join("; ").slice(0, 500)}`);
  const pullRequest = payload.data?.repository?.pullRequest;
  const commit = pullRequest?.commits?.nodes?.at(-1)?.commit;
  if (!pullRequest?.id || commit?.oid !== snapshot.headRevision) throw new Error("GitHub returned incomplete or stale pull request promotion state.");
  const threads = pullRequest.reviewThreads;
  const unresolvedReviewThreads = (threads?.nodes ?? []).filter((thread) => thread && !thread.isResolved).length
    + (threads?.pageInfo?.hasNextPage ? 1 : 0);
  return {
    ...snapshot,
    nodeId: pullRequest.id,
    draft: Boolean(pullRequest.isDraft),
    mergeable: githubMergeable(pullRequest.mergeable),
    mergeStateStatus: pullRequest.mergeStateStatus?.toLowerCase() ?? null,
    reviewDecision: githubReviewDecision(pullRequest.reviewDecision),
    unresolvedReviewThreads,
    checkRollupState: githubCheckRollupState(commit.statusCheckRollup?.state),
    autoMergeEnabled: Boolean(pullRequest.autoMergeRequest),
  } satisfies ImprovementPullRequestSnapshot;
}

/** Retires a check-failing repair PR before a deterministic repair retry is queued. */
export async function retireGitHubPullRequest(
  config: AppConfig,
  snapshot: ImprovementPullRequestSnapshot,
  fetchImpl: typeof fetch = fetch,
) {
  if (snapshot.state !== "open") return;
  const parsed = parseGitHubPullRequestUrl(snapshot.pullRequestUrl);
  const token = await resolveGitHubTaskToken(config);
  if (snapshot.autoMergeEnabled && snapshot.nodeId) {
    const disable = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({
        query: `mutation DisableImprovementAutoMerge($pullRequestId: ID!) {
          disablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) { pullRequest { number } }
        }`,
        variables: { pullRequestId: snapshot.nodeId },
      }),
    });
    if (!disable.ok) throw new Error(`GitHub auto-merge disable failed (${disable.status}): ${(await disable.text()).slice(0, 500)}`);
  }
  const close = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.pullRequestNumber}`,
    { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ state: "closed" }) },
  );
  if (!close.ok) throw new Error(`GitHub pull request close failed (${close.status}): ${(await close.text()).slice(0, 500)}`);
}

function githubHeaders(token: string) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "discord-ai-agent",
  };
}

function githubMergeable(value: string | undefined): NonNullable<ImprovementPullRequestSnapshot["mergeable"]> {
  if (value === "MERGEABLE") return "mergeable";
  if (value === "CONFLICTING") return "conflicting";
  return "unknown";
}

function githubReviewDecision(value: string | null | undefined): ImprovementPullRequestSnapshot["reviewDecision"] {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === "REVIEW_REQUIRED") return "review_required";
  return null;
}

function githubCheckRollupState(value: string | undefined): ImprovementPullRequestSnapshot["checkRollupState"] {
  if (value === "SUCCESS") return "success";
  if (value === "FAILURE") return "failure";
  if (value === "ERROR") return "error";
  if (value === "PENDING" || value === "EXPECTED") return "pending";
  return null;
}
