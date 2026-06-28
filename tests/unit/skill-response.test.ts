import { describe, expect, it } from "vitest";
import { describeSkillPullRequestResult } from "../../src/tools/coreTools.js";

describe("describeSkillPullRequestResult", () => {
  it("describes real skill PRs as human-reviewed", () => {
    expect(
      describeSkillPullRequestResult({
        dryRun: false,
        filePath: "skills/movie-night.md",
        branchName: "discord-ai-agent/skill-movie-night-1",
        prUrl: "https://github.com/owner/repo/pull/1",
        content: "# Movie Night"
      })
    ).toBe("I opened a skill PR for human review: https://github.com/owner/repo/pull/1");
  });

  it("does not surface impossible auto-merge states", () => {
    expect(
      describeSkillPullRequestResult({
        dryRun: false,
        filePath: "skills/movie-night.md",
        branchName: "discord-ai-agent/skill-movie-night-1",
        prUrl: "https://github.com/owner/repo/pull/1",
        autoMergeQueued: true,
        autoMergeError: "Auto-merge is disabled",
        content: "# Movie Night"
      })
    ).toBe("I opened a skill PR for human review: https://github.com/owner/repo/pull/1");
  });

  it("describes policy failures", () => {
    expect(
      describeSkillPullRequestResult({
        dryRun: false,
        filePath: "skills/movie-night.md",
        branchName: "discord-ai-agent/skill-movie-night-1",
        policyReasons: ["mentions sensitive secret env vars"],
        content: "# Movie Night"
      })
    ).toContain("failed policy checks");
  });
});
