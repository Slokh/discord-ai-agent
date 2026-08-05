import type { AppConfig } from "../config/env.js";
import type { ImprovementPullRequestSnapshot } from "../db/types.js";
import { resolveGitHubTaskToken } from "./appToken.js";
import { parseGitHubRepository } from "./repository.js";

type GitHubPullRequestResponse = {
  number?: number;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  html_url?: string;
  merge_commit_sha?: string | null;
  head?: { sha?: string };
  base?: { repo?: { full_name?: string } };
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
  };
}
