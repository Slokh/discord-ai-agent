import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  fetchGitHubPullRequestPromotionSnapshot,
  fetchGitHubPullRequestSnapshot,
  parseGitHubPullRequestUrl,
  retireGitHubPullRequest,
} from "../../src/github/pullRequests.js";

describe("GitHub pull request snapshots", () => {
  it("parses only canonical GitHub pull request URLs", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/Example/Agent/pull/42")).toEqual({
      owner: "Example", repo: "Agent", pullRequestNumber: 42,
    });
    expect(() => parseGitHubPullRequestUrl("https://example.com/Example/Agent/pull/42")).toThrow(/github.com/);
    expect(() => parseGitHubPullRequestUrl("https://github.com/Example/Agent/issues/42")).toThrow(/must look like/);
  });

  it("derives merged state and revisions from live repository data", async () => {
    const config = loadConfig();
    config.github.repository = "Example/Agent";
    config.github.token = "test-token";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      number: 42,
      state: "closed",
      merged: true,
      merged_at: "2026-08-05T00:00:00Z",
      html_url: "https://github.com/Example/Agent/pull/42",
      merge_commit_sha: "merge-sha",
      head: { sha: "head-sha" },
      base: { repo: { full_name: "Example/Agent" } },
    }), { status: 200 }));

    await expect(fetchGitHubPullRequestSnapshot(config, "https://github.com/Example/Agent/pull/42", fetchImpl as typeof fetch))
      .resolves.toEqual({
        repository: "example/agent",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/Example/Agent/pull/42",
        state: "merged",
      headRevision: "head-sha",
      mergeRevision: "merge-sha",
      mergedAt: new Date("2026-08-05T00:00:00Z"),
      nodeId: null,
      draft: false,
      mergeable: "unknown",
      mergeStateStatus: null,
      });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/Example/Agent/pulls/42",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer test-token" }) }),
    );
  });

  it("loads exact check and review state for governed promotion", async () => {
    const config = loadConfig();
    config.github.repository = "Example/Agent";
    config.github.token = "test-token";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        node_id: "PR_node", number: 42, state: "open", draft: false, mergeable: true, mergeable_state: "clean",
        html_url: "https://github.com/Example/Agent/pull/42", head: { sha: "head-sha" },
        base: { repo: { full_name: "Example/Agent" } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { repository: { pullRequest: {
        id: "PR_node", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
        autoMergeRequest: { enabledAt: "2026-08-05T00:00:00Z" },
        reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }], pageInfo: { hasNextPage: false } },
        commits: { nodes: [{ commit: { oid: "head-sha", statusCheckRollup: { state: "SUCCESS" } } }] },
      } } } }), { status: 200 }));

    await expect(fetchGitHubPullRequestPromotionSnapshot(config, "https://github.com/Example/Agent/pull/42", fetchImpl as typeof fetch))
      .resolves.toMatchObject({
        state: "open", headRevision: "head-sha", nodeId: "PR_node", draft: false, mergeable: "mergeable",
        mergeStateStatus: "clean", reviewDecision: null, unresolvedReviewThreads: 1,
        checkRollupState: "success", autoMergeEnabled: true,
      });
  });

  it("disables auto-merge before closing a failed repair pull request", async () => {
    const config = loadConfig();
    config.github.repository = "Example/Agent";
    config.github.token = "test-token";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { disablePullRequestAutoMerge: { pullRequest: { number: 42 } } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "closed" }), { status: 200 }));

    await retireGitHubPullRequest(config, {
      repository: "example/agent", pullRequestNumber: 42, pullRequestUrl: "https://github.com/Example/Agent/pull/42",
      state: "open", headRevision: "head-sha", nodeId: "PR_node", autoMergeEnabled: true,
    }, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.github.com/graphql", expect.objectContaining({ method: "POST" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://api.github.com/repos/Example/Agent/pulls/42", expect.objectContaining({ method: "PATCH" }));
  });

  it("rejects pull requests outside the configured repository", async () => {
    const config = loadConfig();
    config.github.repository = "Example/Agent";
    config.github.token = "test-token";
    await expect(fetchGitHubPullRequestSnapshot(config, "https://github.com/Other/Agent/pull/42", vi.fn() as typeof fetch))
      .rejects.toThrow(/does not match configured repository/);
  });
});
