import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../config/env.js";
import { isMarkdownOnlySkillPath, validateSkillMarkdown } from "./policy.js";
import { slugify } from "../util/text.js";

export type SkillPullRequestResult = {
  dryRun: boolean;
  filePath: string;
  branchName: string;
  prUrl?: string;
  merged?: boolean;
  autoMergeQueued?: boolean;
  autoMergeError?: string;
  policyReasons?: string[];
  content: string;
  dryRunPath?: string;
};

export type ProposalPullRequestResult = {
  dryRun: boolean;
  filePath: string;
  branchName: string;
  prUrl?: string;
  content: string;
  dryRunPath?: string;
};

type DryRunMetadata = {
  kind: "skill" | "tool-proposal";
  title: string;
  branchName: string;
  filePath: string;
  requestedBy: string;
  pullRequestBody: string;
  autoMergeEligible: boolean;
};

type GitHubApi = Pick<Octokit, "git" | "repos" | "pulls">;
type GitHubApiFactory = (token: string) => GitHubApi;

export class GitHubSkillClient {
  constructor(
    private readonly config: AppConfig["github"],
    private readonly createGitHubApi: GitHubApiFactory = (token) => new Octokit({ auth: token })
  ) {}

  async scrubDryRunArtifactsForRequester(userId: string): Promise<number> {
    const dryRunRoot = path.resolve(process.cwd(), this.config.dryRunDir);
    const manifests = await findDryRunManifestPaths(dryRunRoot);

    let removed = 0;
    const removedDirs = new Set<string>();
    for (const manifestPath of manifests) {
      const branchDir = path.dirname(manifestPath);
      if (removedDirs.has(branchDir)) continue;
      const manifest = await readDryRunMetadata(manifestPath);
      if (!manifest || !dryRunMetadataBelongsToRequester(manifest, userId)) continue;
      await fs.rm(branchDir, { recursive: true, force: true });
      removedDirs.add(branchDir);
      removed += 1;
    }
    return removed;
  }

  async createSkillPullRequest(input: {
    title: string;
    skillName: string;
    markdown: string;
    requestedBy: string;
  }): Promise<SkillPullRequestResult> {
    const filePath = `skills/${slugify(input.skillName || input.title || "skill")}.md`;
    const branchName = `discord-ai-agent/skill-${slugify(input.skillName || "skill")}-${uniqueSuffix()}`;
    const policy = validateSkillMarkdown(input.markdown);
    if (!isMarkdownOnlySkillPath(filePath)) {
      policy.reasons.push("skill path must be a Markdown file under skills/");
    }
    if (!policy.ok || policy.reasons.length > 0) {
      return {
        dryRun: this.config.dryRun,
        filePath,
        branchName,
        policyReasons: policy.reasons,
        content: input.markdown
      };
    }

    if (this.config.dryRun) {
      const dryRunPath = await this.writeDryRunArtifact(
        branchName,
        filePath,
        input.markdown,
        skillDryRunMetadata({
          title: input.title,
          branchName,
          filePath,
          requestedBy: input.requestedBy
        })
      );
      return {
        dryRun: true,
        filePath,
        branchName,
        content: input.markdown,
        dryRunPath
      };
    }

    if (!this.config.token) {
      throw new Error("GITHUB_TOKEN is required because real GitHub PR mode is enabled.");
    }
    const { owner, repo } = parseGitHubRepository(this.config.repository);

    const octokit = this.createGitHubApi(this.config.token);
    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${this.config.baseBranch}`
    });

    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.data.object.sha
    });

    const existing = await octokit.repos
      .getContent({ owner, repo, path: filePath, ref: branchName })
      .catch((error: any) => {
        if (error?.status === 404) return undefined;
        throw error;
      });

    const sha = existing && !Array.isArray(existing.data) && "sha" in existing.data ? existing.data.sha : undefined;
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      branch: branchName,
      sha,
      message: `Apply Discord AI Agent skill: ${input.skillName}`,
      content: Buffer.from(input.markdown, "utf8").toString("base64"),
      committer: {
        name: "discord-ai-agent",
        email: "discord-ai-agent-bot@users.noreply.github.com"
      }
    });

    const pr = await octokit.pulls.create({
      owner,
      repo,
      title: input.title,
      head: branchName,
      base: this.config.baseBranch,
      body: skillPullRequestBody(input.requestedBy)
    });

    return {
      dryRun: false,
      filePath,
      branchName,
      prUrl: pr.data.html_url,
      merged: false,
      content: input.markdown
    };
  }

  async createToolProposalPullRequest(input: {
    title: string;
    proposalName: string;
    markdown: string;
    requestedBy: string;
  }): Promise<ProposalPullRequestResult> {
    const stamp = uniqueSuffix();
    const filePath = `tool-requests/${slugify(input.proposalName || input.title || "tool")}-${stamp}.md`;
    const branchName = `discord-ai-agent/tool-${slugify(input.proposalName || "tool")}-${stamp}`;

    if (this.config.dryRun) {
      const pullRequestBody = toolProposalPullRequestBody(input.requestedBy);
      const dryRunPath = await this.writeDryRunArtifact(branchName, filePath, input.markdown, {
        kind: "tool-proposal",
        title: input.title,
        branchName,
        filePath,
        requestedBy: input.requestedBy,
        pullRequestBody,
        autoMergeEligible: false
      });
      return {
        dryRun: true,
        filePath,
        branchName,
        content: input.markdown,
        dryRunPath
      };
    }

    if (!this.config.token) {
      throw new Error("GITHUB_TOKEN is required because real GitHub PR mode is enabled.");
    }
    const { owner, repo } = parseGitHubRepository(this.config.repository);

    const octokit = this.createGitHubApi(this.config.token);
    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${this.config.baseBranch}`
    });

    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.data.object.sha
    });

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      branch: branchName,
      message: `Propose Discord AI Agent tool: ${input.proposalName}`,
      content: Buffer.from(input.markdown, "utf8").toString("base64"),
      committer: {
        name: "discord-ai-agent",
        email: "discord-ai-agent-bot@users.noreply.github.com"
      }
    });

    const pr = await octokit.pulls.create({
      owner,
      repo,
      title: input.title,
      head: branchName,
      base: this.config.baseBranch,
      body: toolProposalPullRequestBody(input.requestedBy)
    });

    return {
      dryRun: false,
      filePath,
      branchName,
      prUrl: pr.data.html_url,
      content: input.markdown
    };
  }

  private async writeDryRunArtifact(branchName: string, filePath: string, content: string, metadata: DryRunMetadata) {
    const artifactPath = path.resolve(process.cwd(), this.config.dryRunDir, branchName, filePath);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, content, "utf8");
    await fs.writeFile(
      path.resolve(process.cwd(), this.config.dryRunDir, branchName, "discord-ai-agent-dry-run.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );
    return artifactPath;
  }
}

async function findDryRunManifestPaths(root: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const manifests: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "discord-ai-agent-dry-run.json") {
      manifests.push(entryPath);
    } else if (entry.isDirectory()) {
      manifests.push(...(await findDryRunManifestPaths(entryPath)));
    }
  }
  return manifests;
}

async function readDryRunMetadata(filePath: string): Promise<DryRunMetadata | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as DryRunMetadata;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function dryRunMetadataBelongsToRequester(metadata: DryRunMetadata, userId: string) {
  return metadata.requestedBy.includes(`(${userId})`) || metadata.requestedBy === userId || metadata.requestedBy.endsWith(` ${userId}`);
}

function uniqueSuffix() {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function parseGitHubRepository(repository: string | undefined) {
  if (!repository) throw new Error("GitHub repository must be configured as owner/repo.");
  if (repository === "owner/repo") {
    throw new Error("GitHub repository is still set to the placeholder owner/repo.");
  }

  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) throw new Error("GitHub repository must be owner/repo.");
  return { owner, repo };
}

function skillDryRunMetadata(input: {
  title: string;
  branchName: string;
  filePath: string;
  requestedBy: string;
}): DryRunMetadata {
  return {
    kind: "skill",
    title: input.title,
    branchName: input.branchName,
    filePath: input.filePath,
    requestedBy: input.requestedBy,
    pullRequestBody: skillPullRequestBody(input.requestedBy),
    autoMergeEligible: false
  };
}

function skillPullRequestBody(requestedBy: string) {
  return (
    `Skill proposed by ${requestedBy} via Discord AI Agent.\n\n` +
    "This PR is Markdown-only and passed local skill policy checks. A human must review and merge it."
  );
}

function toolProposalPullRequestBody(requestedBy: string) {
  return (
    `Tool/code change proposed by ${requestedBy} via Discord AI Agent.\n\n` +
    "Discord AI Agent never auto-merges tool or code changes; a human must review and implement/merge this PR."
  );
}
