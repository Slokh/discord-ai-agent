import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Octokit } from "@octokit/rest";
import { slugify } from "../util/text.js";
import { progress } from "./callbacks.js";
import { execFileText, runCommand } from "./commands.js";
import type { SandboxEnv } from "./sandboxEnv.js";
import { MAX_ACTIVITY_COMMAND_OUTPUT, pathExists, sha256, tail, withDirectoryLock } from "./sandboxUtils.js";

const STALE_WORKSPACE_MS = 6 * 60 * 60 * 1000;

export type GitChangeState = {
  baseRevision: string;
  headRevision: string;
  status: string;
  commitsAhead: number;
  hasWorkingTreeChanges: boolean;
  hasCommittedChanges: boolean;
  hasChanges: boolean;
};

export type CodeUpdateTarget = {
  generatedBranchName: string;
  branchName: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  updateExistingBranch: boolean;
};

export type SandboxCachePaths = {
  rootDir: string;
  reposDir: string;
  locksDir: string;
  workspacesDir: string;
  npmCacheDir: string;
  nodeModulesDir: string;
  mirrorDir: string;
  repoLockDir: string;
};

export function sandboxCachePaths(env: SandboxEnv, owner: string, repo: string): SandboxCachePaths {
  const rootDir = env.sandboxCacheDir || path.join(os.tmpdir(), "discord-ai-agent-cache");
  const repoKey = `${slugify(`${owner}-${repo}`) || "repo"}-${sha256(`${owner}/${repo}`).slice(0, 10)}`;
  const reposDir = path.join(rootDir, "repos");
  const locksDir = path.join(rootDir, "locks");
  return {
    rootDir,
    reposDir,
    locksDir,
    workspacesDir: path.join(os.tmpdir(), "discord-ai-agent-workspaces", repoKey),
    npmCacheDir: path.join(rootDir, "npm"),
    nodeModulesDir: path.join(rootDir, "node_modules"),
    mirrorDir: path.join(reposDir, `${repoKey}.git`),
    repoLockDir: path.join(locksDir, `${repoKey}.repo.lock`)
  };
}

export async function prepareCachedWorktree(input: {
  env: SandboxEnv;
  cache: SandboxCachePaths;
  owner: string;
  repo: string;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  workRoot: string;
}): Promise<{ cacheStatus: "hit" | "miss" }> {
  await fs.mkdir(input.cache.reposDir, { recursive: true });
  await fs.mkdir(input.cache.locksDir, { recursive: true });
  const repoUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  let cacheStatus: "hit" | "miss" = "miss";

  await withDirectoryLock(input.cache.repoLockDir, async () => {
    if (await pathExists(path.join(input.cache.mirrorDir, "HEAD"))) {
      cacheStatus = "hit";
      await progress(input.env, "repo_refresh", "Fetching latest changes into the cached repository mirror.", {
        mirrorDir: input.cache.mirrorDir,
        cacheType: "repo",
        cacheStatus
      });
      await runCommand("git", ["-C", input.cache.mirrorDir, "remote", "set-url", "origin", repoUrl], {
        cwd: input.cache.reposDir,
        env: input.gitEnv,
        taskEnv: input.env,
        step: "repo_refresh"
      });
      await runCommand("git", ["-C", input.cache.mirrorDir, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], {
        cwd: input.cache.reposDir,
        env: input.gitEnv,
        taskEnv: input.env,
        step: "repo_refresh"
      });
    } else {
      cacheStatus = "miss";
      await progress(input.env, "repo_seed", "Seeding the cached repository mirror.", {
        mirrorDir: input.cache.mirrorDir,
        cacheType: "repo",
        cacheStatus
      });
      await fs.rm(input.cache.mirrorDir, { recursive: true, force: true }).catch(() => undefined);
      await runCommand("git", ["clone", "--mirror", repoUrl, input.cache.mirrorDir], {
        cwd: input.cache.reposDir,
        env: input.gitEnv,
        taskEnv: input.env,
        step: "repo_seed"
      });
    }

    await runCommand("git", ["--git-dir", input.cache.mirrorDir, "worktree", "prune"], {
      cwd: input.workRoot,
      env: input.gitEnv,
      taskEnv: input.env,
      step: "repo_checkout"
    });
    await runCommand(
      "git",
      ["--git-dir", input.cache.mirrorDir, "worktree", "add", "--detach", input.checkoutDir, `refs/heads/${input.env.githubBaseBranch}`],
      {
        cwd: input.workRoot,
        env: input.gitEnv,
        taskEnv: input.env,
        step: "repo_checkout"
      }
    );
    await repairWorktreeRemoteForBranchPush({
      checkoutDir: input.checkoutDir,
      repoUrl,
      gitEnv: input.gitEnv,
      taskEnv: input.env
    });
  });
  return { cacheStatus };
}

export function codeUpdateTargetFromInputs(input: {
  generatedBranchName: string;
  targetBranch?: string | null;
  targetPullRequestNumber?: number | null;
  targetPullRequestUrl?: string | null;
}): CodeUpdateTarget {
  const targetBranch = input.targetBranch?.trim() || null;
  const targetPullRequestUrl = input.targetPullRequestUrl?.trim() || null;
  const targetPullRequestNumber = positiveInteger(input.targetPullRequestNumber) ?? pullRequestNumberFromUrl(targetPullRequestUrl);
  const updateExistingBranch = Boolean(targetBranch || targetPullRequestNumber || targetPullRequestUrl);
  return {
    generatedBranchName: input.generatedBranchName,
    branchName: targetBranch ?? input.generatedBranchName,
    pullRequestNumber: targetPullRequestNumber,
    pullRequestUrl: targetPullRequestUrl,
    updateExistingBranch
  };
}

export async function resolveCodeUpdateTarget(input: {
  env: SandboxEnv;
  octokit: Octokit;
  owner: string;
  repo: string;
  generatedBranchName: string;
}): Promise<CodeUpdateTarget> {
  let target = codeUpdateTargetFromInputs({
    generatedBranchName: input.generatedBranchName,
    targetBranch: input.env.targetBranch,
    targetPullRequestNumber: input.env.targetPullRequestNumber,
    targetPullRequestUrl: input.env.targetPullRequestUrl
  });

  if (target.pullRequestNumber) {
    const pullRequest = await input.octokit.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: target.pullRequestNumber
    });
    const branchName = input.env.targetBranch?.trim() || pullRequest.data.head?.ref;
    if (!branchName) throw new Error(`Could not resolve branch for target PR #${target.pullRequestNumber}.`);
    target = {
      ...target,
      branchName,
      pullRequestUrl: pullRequest.data.html_url ?? target.pullRequestUrl,
      updateExistingBranch: true
    };
    await progress(input.env, "target_pr_resolved", `Resolved target PR #${target.pullRequestNumber} on branch ${branchName}.`, {
      branchName,
      pullRequestNumber: target.pullRequestNumber,
      pullRequestUrl: target.pullRequestUrl
    });
    assertCodeUpdatePushAllowed({
      branchName: target.branchName,
      baseBranch: input.env.githubBaseBranch,
      hasResolvedPullRequest: target.pullRequestNumber != null
    });
    return target;
  }

  if (input.env.targetBranch?.trim()) {
    const pullRequests = await input.octokit.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: "open",
      head: `${input.owner}:${target.branchName}`,
      per_page: 1
    });
    const pullRequest = pullRequests.data[0];
    if (pullRequest?.number) {
      target = {
        ...target,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.html_url ?? null,
        updateExistingBranch: true
      };
      await progress(input.env, "target_pr_resolved", `Resolved target branch ${target.branchName} to PR #${pullRequest.number}.`, {
        branchName: target.branchName,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: target.pullRequestUrl
      });
    }
  }

  assertCodeUpdatePushAllowed({
    branchName: target.branchName,
    baseBranch: input.env.githubBaseBranch,
    hasResolvedPullRequest: target.pullRequestNumber != null
  });
  return target;
}

export async function checkoutExistingTargetBranch(input: { env: SandboxEnv; checkoutDir: string; gitEnv: NodeJS.ProcessEnv; branchName: string }) {
  await runCommand("git", ["fetch", "origin", `refs/heads/${input.branchName}:refs/remotes/origin/${input.branchName}`], {
    cwd: input.checkoutDir,
    env: input.gitEnv,
    taskEnv: input.env,
    step: "branch"
  });
  await runCommand("git", ["checkout", "-B", input.branchName, `refs/remotes/origin/${input.branchName}`], {
    cwd: input.checkoutDir,
    env: input.gitEnv,
    taskEnv: input.env,
    step: "branch"
  });
}

export async function repairWorktreeRemoteForBranchPush(input: {
  checkoutDir: string;
  repoUrl: string;
  gitEnv?: NodeJS.ProcessEnv;
  taskEnv?: SandboxEnv;
}) {
  await runCommand("git", ["remote", "set-url", "origin", input.repoUrl], {
    cwd: input.checkoutDir,
    env: input.gitEnv,
    taskEnv: input.taskEnv,
    step: "repo_checkout"
  });
  await runCommand("git", ["config", "--unset-all", "remote.origin.mirror"], {
    cwd: input.checkoutDir,
    env: input.gitEnv,
    allowFailure: true,
    taskEnv: input.taskEnv,
    step: "repo_checkout"
  });
}

export async function removeCachedWorktree(mirrorDir: string, checkoutDir: string) {
  if (!(await pathExists(path.join(mirrorDir, "HEAD")))) return;
  await runCommand("git", ["--git-dir", mirrorDir, "worktree", "remove", "--force", checkoutDir], {
    cwd: path.dirname(checkoutDir),
    allowFailure: true
  });
  await runCommand("git", ["--git-dir", mirrorDir, "worktree", "prune"], {
    cwd: path.dirname(checkoutDir),
    allowFailure: true
  });
}

export async function pruneOldWorkspaceDirs(workspacesDir: string) {
  if (!(await pathExists(workspacesDir))) return;
  const entries = await fs.readdir(workspacesDir, { withFileTypes: true });
  const cutoff = Date.now() - STALE_WORKSPACE_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("task-"))
      .map(async (entry) => {
        const entryPath = path.join(workspacesDir, entry.name);
        const stat = await fs.stat(entryPath).catch(() => null);
        if (!stat || stat.mtimeMs > cutoff) return;
        await fs.rm(entryPath, { recursive: true, force: true });
      })
  );
}

export function branchPushRef(branchName: string): string {
  return `refs/heads/${branchName}`;
}

const CODE_UPDATE_BRANCH_ALLOWED_PREFIXES = ["ai/", "agent/"];
const PROTECTED_BRANCH_NAMES = new Set(["main", "master", "develop", "production", "release"]);
const PROTECTED_BRANCH_PREFIXES = ["release/", "hotfix/"];

export function assertCodeUpdatePushAllowed(input: { branchName: string; baseBranch: string; hasResolvedPullRequest?: boolean }): void {
  const branchName = input.branchName.trim();
  const baseBranch = input.baseBranch.trim();
  if (!branchName) {
    throw new Error("Refusing to push: the code-update branch name is empty.");
  }
  const normalized = branchName.toLowerCase();
  if (baseBranch && normalized === baseBranch.toLowerCase()) {
    throw new Error(`Refusing to push code-update changes directly to the base branch "${baseBranch}". Code updates must go through a PR branch.`);
  }
  if (PROTECTED_BRANCH_NAMES.has(normalized) || PROTECTED_BRANCH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`Refusing to push code-update changes to protected branch "${branchName}". Code updates must go through a PR branch.`);
  }
  const hasAllowedPrefix = CODE_UPDATE_BRANCH_ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!hasAllowedPrefix && !input.hasResolvedPullRequest) {
    throw new Error(
      `Refusing to push to branch "${branchName}": code-update branches must start with ${CODE_UPDATE_BRANCH_ALLOWED_PREFIXES.map((prefix) => `"${prefix}"`).join(" or ")} unless they belong to an existing open pull request.`
    );
  }
}

function positiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : null;
}

function pullRequestNumberFromUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const pullIndex = parts.indexOf("pull");
    if (url.hostname.toLowerCase() !== "github.com" || pullIndex < 0) return null;
    const prNumber = Number(parts[pullIndex + 1]);
    return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
  } catch {
    return null;
  }
}

export async function gitStatusPorcelain(checkoutDir: string) {
  const result = await execFileText("git", ["status", "--porcelain"], { cwd: checkoutDir });
  return result.stdout;
}

export async function gitRevision(checkoutDir: string, revision: string) {
  const result = await execFileText("git", ["rev-parse", revision], { cwd: checkoutDir });
  return result.stdout.trim();
}

export async function readGitChangeState(checkoutDir: string, baseRevision: string): Promise<GitChangeState> {
  const [status, headRevision, commitsAheadText] = await Promise.all([
    gitStatusPorcelain(checkoutDir),
    gitRevision(checkoutDir, "HEAD"),
    execFileText("git", ["rev-list", "--count", `${baseRevision}..HEAD`], { cwd: checkoutDir }).then((result) => result.stdout.trim())
  ]);
  const commitsAhead = Number.parseInt(commitsAheadText, 10) || 0;
  const hasWorkingTreeChanges = Boolean(status.trim());
  const hasCommittedChanges = commitsAhead > 0;
  return {
    baseRevision,
    headRevision,
    status,
    commitsAhead,
    hasWorkingTreeChanges,
    hasCommittedChanges,
    hasChanges: hasWorkingTreeChanges || hasCommittedChanges
  };
}

export function gitChangeStateMetadata(changeState: GitChangeState) {
  return {
    baseRevision: changeState.baseRevision,
    headRevision: changeState.headRevision,
    commitsAhead: changeState.commitsAhead,
    hasWorkingTreeChanges: changeState.hasWorkingTreeChanges,
    hasCommittedChanges: changeState.hasCommittedChanges,
    gitStatus: tail(changeState.status, MAX_ACTIVITY_COMMAND_OUTPUT)
  };
}

export async function gitAuthEnv(token: string, workRoot: string): Promise<NodeJS.ProcessEnv> {
  const askPassPath = path.join(workRoot, "git-askpass.sh");
  await fs.writeFile(
    askPassPath,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) printf '%s\\n' 'x-access-token' ;;",
      "  *) printf '%s\\n' \"$GITHUB_TOKEN\" ;;",
      "esac",
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 }
  );

  return {
    ...process.env,
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
    GIT_ASKPASS: askPassPath,
    GIT_TERMINAL_PROMPT: "0"
  };
}
