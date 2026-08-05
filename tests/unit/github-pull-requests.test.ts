import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { fetchGitHubPullRequestSnapshot, parseGitHubPullRequestUrl } from "../../src/github/pullRequests.js";

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
      });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/Example/Agent/pulls/42",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer test-token" }) }),
    );
  });

  it("rejects pull requests outside the configured repository", async () => {
    const config = loadConfig();
    config.github.repository = "Example/Agent";
    config.github.token = "test-token";
    await expect(fetchGitHubPullRequestSnapshot(config, "https://github.com/Other/Agent/pull/42", vi.fn() as typeof fetch))
      .rejects.toThrow(/does not match configured repository/);
  });
});
