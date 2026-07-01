import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { slugify } from "../util/text.js";

const MAX_CAPTURED_COMMAND_OUTPUT = 40_000;
const MAX_ACTIVITY_COMMAND_OUTPUT = 12_000;
const STALE_WORKSPACE_MS = 6 * 60 * 60 * 1000;
const COMMAND_ACTIVITY_INTERVAL_MS = 30_000;
const CODEX_NO_FIRST_DIFF_TIMEOUT_MS = 8 * 60 * 1000;
const CODEX_IDLE_TIMEOUT_MS = 6 * 60 * 1000;
const CODEX_RECONNECT_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const CODEX_MAX_RUNTIME_MS = 25 * 60 * 1000;
const CODEX_TERMINATE_GRACE_MS = 5_000;
const CODEX_RECONNECT_PATTERN = /(?:^|\n)ERROR:\s*Reconnecting\.\.\./i;

type SandboxEnv = {
  taskId: string;
  traceId: string;
  sandboxRunId: string;
  taskTitle: string;
  taskRequest: string;
  requestedBy: string;
  controlPlaneInternalUrl: string;
  taskToken: string;
  githubToken: string;
  githubRepository: string;
  githubBaseBranch: string;
  openRouterApiKey: string;
  openRouterChatModel: string;
  sandboxCacheDir: string;
  sandboxStartedAtMs: number | null;
};

type TaskTimings = Record<string, number>;

type CacheSummary = {
  repo?: "hit" | "miss";
  dependencies?: "hit" | "miss";
  dependencyCacheKey?: string;
  dependencyFilesChanged?: string[];
  dependencyRefreshAfterCodex?: boolean;
  toolShims?: string[];
};

export type CommandWatchdog = {
  kind: "codex";
  noFirstDiffTimeoutMs: number;
  idleTimeoutMs: number;
  reconnectStallTimeoutMs: number;
  maxRuntimeMs: number;
  activityIntervalMs?: number;
};

type GitWorkingTreeSnapshot = {
  hasDiff: boolean;
  status: string;
  diffStat: string;
  changedFiles: string[];
  error?: string;
};

export type CodegenContextPack = {
  focus: string;
  rationale: string;
  likelyMechanisms: string[];
  suggestedFiles: Array<{ path: string; reason: string }>;
  firstInvariant: string;
  suggestedFirstEdit: string;
  avoid: string[];
};

export type CodegenWatchdogInput = {
  elapsedMs: number;
  idleMs: number;
  hasDiff: boolean;
  reconnectSeen: boolean;
  reconnectStallMs: number | null;
  noFirstDiffTimeoutMs?: number;
  idleTimeoutMs?: number;
  reconnectStallTimeoutMs?: number;
  maxRuntimeMs?: number;
};

export type CodegenWatchdogDecision = {
  action: "fail" | "continue";
  reason: "no_first_diff" | "idle_before_diff" | "idle_after_diff" | "reconnect_stall" | "max_runtime";
  message: string;
};

class CodegenWatchdogError extends Error {
  constructor(
    message: string,
    readonly decision: CodegenWatchdogDecision,
    readonly metadata: Record<string, unknown>
  ) {
    super(message);
    this.name = "CodegenWatchdogError";
  }
}

async function main() {
  const env = loadSandboxEnv();
  const timings: TaskTimings = {};
  const totalStartedAt = Date.now();
  try {
    const result = await runCodeUpdate(env, timings, totalStartedAt);
    await complete(env, {
      status: "succeeded",
      branchName: result.branchName,
      prUrl: result.prUrl,
      draft: result.draft,
      verifyPassed: result.verifyPassed,
      metadata: { timingsMs: result.timings, cache: result.cacheSummary }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    timings.total = Date.now() - totalStartedAt;
    const watchdogMetadata =
      error instanceof CodegenWatchdogError
        ? { diagnosis: error.message, watchdog: { decision: error.decision, ...error.metadata } }
        : {};
    await complete(env, {
      status: message.includes("produced no diff") ? "no_changes" : "failed",
      error: message,
      metadata: { timingsMs: timings, ...watchdogMetadata }
    }).catch((callbackError) => {
      console.error("Failed to post terminal task callback", callbackError);
    });
    throw error;
  }
}

async function runCodeUpdate(env: SandboxEnv, timings: TaskTimings, totalStartedAt: number) {
  const { owner, repo } = parseGitHubRepository(env.githubRepository);
  const branchName = codeUpdateBranchName(env.taskTitle);
  const cache = sandboxCachePaths(env, owner, repo);
  const cacheSummary: CacheSummary = {};
  await fs.mkdir(cache.workspacesDir, { recursive: true });
  await pruneOldWorkspaceDirs(cache.workspacesDir).catch((error) => {
    console.error("Failed to prune old sandbox workspaces", error);
  });
  const workRoot = await fs.mkdtemp(path.join(cache.workspacesDir, "task-"));
  const checkoutDir = path.join(workRoot, "repo");
  const gitEnv = await gitAuthEnv(env.githubToken, workRoot);

  try {
    if (env.sandboxStartedAtMs != null) {
      timings.sandboxStartup = Math.max(0, Date.now() - env.sandboxStartedAtMs);
      await progress(env, "sandbox_acquired", "Sandbox process started.", { durationMs: timings.sandboxStartup });
    }

    await timedPhase(env, timings, "repo", "Refreshing cached repository mirror and creating a task worktree.", async () => {
      const repoCache = await prepareCachedWorktree({
        env,
        cache,
        owner,
        repo,
        checkoutDir,
        gitEnv,
        workRoot
      });
      cacheSummary.repo = repoCache.cacheStatus;
    });

    await progress(env, "branch", `Creating implementation branch ${branchName}.`, { branchName });
    await runCommand("git", ["checkout", "-b", branchName], { cwd: checkoutDir, taskEnv: env, step: "branch" });

    const dependencyStateBeforeCodex = await readDependencyManifestState(checkoutDir);
    await timedPhase(env, timings, "dependencies", "Preparing dependencies from the shared sandbox cache.", async () => {
      const dependencyCache = await prepareDependencies({ env, cache, checkoutDir });
      cacheSummary.dependencies = dependencyCache.cacheStatus;
      cacheSummary.dependencyCacheKey = dependencyCache.lockHash;
    });

    const toolShimDir = path.join(workRoot, "tool-shims");
    await timedPhase(env, timings, "toolShims", "Installing sandbox helper tool shims for Codex.", async () => {
      const shims = await writeSandboxToolShims(toolShimDir);
      cacheSummary.toolShims = shims;
      await progress(env, "tool_shims_ready", "Sandbox helper tools are available on PATH.", { toolShims: shims });
    });

    await progress(env, "configure", "Writing ephemeral Codex configuration.");
    await writeCodexConfig(workRoot, checkoutDir, env);

    const contextPack = await timedPhase(
      env,
      timings,
      "context",
      "Building focused codegen request context.",
      () => buildCodegenContextPack(checkoutDir, env.taskRequest)
    );
    await recordArtifact(env, {
      kind: "diagnostic",
      name: "Codegen request context",
      content: renderCodegenContextPack(contextPack),
      contentType: "text/markdown",
      metadata: {
        focus: contextPack.focus,
        suggestedFiles: contextPack.suggestedFiles.map((file) => file.path)
      }
    });

    const codexPrompt = codeUpdatePrompt(env, contextPack);
    await recordArtifact(env, {
      kind: "prompt",
      name: "Codex prompt",
      content: codexPrompt,
      contentType: "text/plain",
      metadata: { model: env.openRouterChatModel }
    });

    await timedPhase(env, timings, "codex", "Running Codex to implement the requested change.", async () => {
      await runCommand(
        process.env.CODEX_BIN || "codex",
        codexExecArgs({ checkoutDir, model: env.openRouterChatModel }),
        {
          cwd: checkoutDir,
          env: codexEnv(env, gitEnv, workRoot, toolShimDir),
          input: codexPrompt,
          taskEnv: env,
          step: "codex",
          watchdog: codegenWatchdog()
        }
      );
    }, { model: env.openRouterChatModel });

    await progress(env, "diff", "Checking whether Codex produced a real code diff.");
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: checkoutDir, taskEnv: env, step: "diff" });
    if (!status.stdout.trim()) {
      throw new Error("Agent task produced no diff; no PR will be opened.");
    }
    const diffStat = await runCommand("git", ["diff", "--stat"], { cwd: checkoutDir, taskEnv: env, step: "diff_stat" });
    await recordArtifact(env, {
      kind: "diff",
      name: "Git diff stat",
      content: diffStat.stdout,
      contentType: "text/plain",
      metadata: { command: "git diff --stat" }
    });
    const diffPatch = await runCommand("git", ["diff", "--no-ext-diff"], { cwd: checkoutDir, taskEnv: env, step: "diff_patch" });
    await recordArtifact(env, {
      kind: "diff",
      name: "Git patch",
      content: diffPatch.stdout,
      contentType: "text/x-diff",
      metadata: { command: "git diff --no-ext-diff" }
    });

    const dependencyStateAfterCodex = await readDependencyManifestState(checkoutDir);
    const dependencyFilesChanged = changedDependencyManifestFiles(dependencyStateBeforeCodex, dependencyStateAfterCodex);
    if (dependencyFilesChanged.length > 0) {
      cacheSummary.dependencyFilesChanged = dependencyFilesChanged;
      cacheSummary.dependencyRefreshAfterCodex = true;
      await timedPhase(
        env,
        timings,
        "dependenciesPostCodex",
        "Dependency files changed; refreshing dependencies before verification.",
        async () => {
          const dependencyCache = await prepareDependencies({
            env,
            cache,
            checkoutDir,
            reason: "dependency_files_changed_after_codex"
          });
          cacheSummary.dependencies = dependencyCache.cacheStatus;
          cacheSummary.dependencyCacheKey = dependencyCache.lockHash;
        },
        { dependencyFilesChanged }
      );
    }

    const verify = await timedPhase(env, timings, "verify", "Running npm run verify on the generated changes.", async () =>
      runCommand("npm", ["run", "verify"], { cwd: checkoutDir, allowFailure: true, taskEnv: env, step: "verify" })
    );
    const scan = await timedPhase(env, timings, "scan", "Running release scan before pushing generated changes.", async () =>
      runCommand("npm", ["run", "scan:release"], { cwd: checkoutDir, allowFailure: true, taskEnv: env, step: "scan" })
    );
    if (scan.exitCode !== 0) {
      throw new Error("Release scan failed after agent task; refusing to push generated changes.");
    }

    await progress(env, "commit", "Committing generated changes.");
    await runCommand("git", ["config", "user.name", "discord-ai-agent"], { cwd: checkoutDir, taskEnv: env, step: "commit" });
    await runCommand("git", ["config", "user.email", "discord-ai-agent-bot@users.noreply.github.com"], {
      cwd: checkoutDir,
      taskEnv: env,
      step: "commit"
    });
    await runCommand("git", ["add", "-A"], { cwd: checkoutDir, taskEnv: env, step: "commit" });
    await runCommand("git", ["commit", "-m", `Implement Discord AI Agent update: ${env.taskTitle}`], {
      cwd: checkoutDir,
      taskEnv: env,
      step: "commit"
    });
    await timedPhase(env, timings, "push", "Pushing the generated branch to GitHub.", async () => {
      await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: checkoutDir, env: gitEnv, taskEnv: env, step: "push" });
    }, { branchName });

    const draft = verify.exitCode !== 0;
    const octokit = new Octokit({ auth: env.githubToken });
    const initialPrBody = pullRequestBody({ env, verifyPassed: verify.exitCode === 0, timings, cacheSummary });
    const pr = await timedPhase(env, timings, "pr", "Opening the GitHub pull request.", async () =>
      octokit.pulls.create({
        owner,
        repo,
        title: `Update Discord AI Agent: ${env.taskTitle}`,
        head: branchName,
        base: env.githubBaseBranch,
        draft,
        body: initialPrBody
      }), { draft }
    );

    timings.total = Date.now() - totalStartedAt;
    const finalPrBody = pullRequestBody({ env, verifyPassed: verify.exitCode === 0, timings, cacheSummary });
    await octokit.pulls
      .update({
        owner,
        repo,
        pull_number: pr.data.number,
        body: finalPrBody
      })
      .catch((error) => {
        console.error("Failed to update PR body with final timings", error);
      });
    await recordArtifact(env, {
      kind: "pr_body",
      name: "Pull request body",
      content: finalPrBody,
      contentType: "text/markdown",
      metadata: { prUrl: pr.data.html_url, draft, verifyPassed: verify.exitCode === 0 }
    });
    await progress(env, "task_complete", "Code update task finished.", {
      durationMs: timings.total,
      timingsMs: timings,
      cache: cacheSummary
    });

    return {
      branchName,
      prUrl: pr.data.html_url,
      draft,
      verifyPassed: verify.exitCode === 0,
      timings,
      cacheSummary
    };
  } finally {
    await progress(env, "cleanup", "Cleaning up the ephemeral sandbox checkout.").catch(() => undefined);
    await removeCachedWorktree(cache.mirrorDir, checkoutDir).catch(() => undefined);
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function loadSandboxEnv(): SandboxEnv {
  return {
    taskId: requiredEnv("TASK_ID"),
    traceId: requiredEnv("TRACE_ID"),
    sandboxRunId: requiredEnv("SANDBOX_RUN_ID"),
    taskTitle: requiredEnv("TASK_TITLE"),
    taskRequest: requiredEnv("TASK_REQUEST"),
    requestedBy: requiredEnv("REQUESTED_BY"),
    controlPlaneInternalUrl: requiredEnv("CONTROL_PLANE_INTERNAL_URL").replace(/\/$/, ""),
    taskToken: requiredEnv("AGENT_TASK_TOKEN"),
    githubToken: requiredEnv("GITHUB_TOKEN"),
    githubRepository: requiredEnv("GITHUB_REPOSITORY"),
    githubBaseBranch: requiredEnv("GITHUB_BASE_BRANCH"),
    openRouterApiKey: requiredEnv("OPENROUTER_API_KEY"),
    openRouterChatModel: requiredEnv("OPENROUTER_CHAT_MODEL"),
    sandboxCacheDir: process.env.SANDBOX_CACHE_DIR || path.join(os.tmpdir(), "discord-ai-agent-cache"),
    sandboxStartedAtMs: numberEnv("SANDBOX_STARTED_AT_MS")
  };
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in the sandbox environment.`);
  return value;
}

function numberEnv(name: string) {
  const value = process.env[name];
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function timedPhase<T>(
  env: SandboxEnv,
  timings: TaskTimings,
  step: string,
  message: string,
  run: () => Promise<T>,
  metadata: Record<string, unknown> = {}
): Promise<T> {
  await progress(env, step, message, metadata);
  const startedAt = Date.now();
  try {
    const result = await run();
    const durationMs = Date.now() - startedAt;
    timings[step] = durationMs;
    await progress(env, `${step}_complete`, `Finished ${step} in ${formatDuration(durationMs)}.`, { ...metadata, durationMs });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    timings[step] = durationMs;
    await progress(env, `${step}_failed`, `${step} failed after ${formatDuration(durationMs)}.`, {
      ...metadata,
      durationMs,
      error: conciseError(error)
    }).catch(() => undefined);
    throw error;
  }
}

type SandboxCachePaths = {
  rootDir: string;
  reposDir: string;
  locksDir: string;
  workspacesDir: string;
  npmCacheDir: string;
  nodeModulesDir: string;
  mirrorDir: string;
  repoLockDir: string;
};

function sandboxCachePaths(env: SandboxEnv, owner: string, repo: string): SandboxCachePaths {
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

async function prepareCachedWorktree(input: {
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

async function prepareDependencies(input: {
  env: SandboxEnv;
  cache: SandboxCachePaths;
  checkoutDir: string;
  reason?: string;
}): Promise<{ cacheStatus: "hit" | "miss"; lockHash: string }> {
  await fs.mkdir(input.cache.npmCacheDir, { recursive: true });
  await fs.mkdir(input.cache.nodeModulesDir, { recursive: true });
  await fs.mkdir(input.cache.locksDir, { recursive: true });
  const lockHash = await dependencyCacheKey(input.checkoutDir);
  const nodeModulesPath = path.join(input.checkoutDir, "node_modules");
  const cachedNodeModulesPath = path.join(input.cache.nodeModulesDir, lockHash);
  const lockDir = path.join(input.cache.locksDir, `${lockHash}.node-modules.lock`);

  if (await pathExists(cachedNodeModulesPath)) {
    const restored = await restoreCachedNodeModules({
      env: input.env,
      lockHash,
      reason: input.reason,
      cachedNodeModulesPath,
      nodeModulesPath
    });
    if (restored) return { cacheStatus: "hit", lockHash };
  }

  let cacheStatus: "hit" | "miss" = "miss";
  await withDirectoryLock(lockDir, async () => {
    if (await pathExists(cachedNodeModulesPath)) {
      const restored = await restoreCachedNodeModules({
        env: input.env,
        lockHash,
        reason: input.reason,
        cachedNodeModulesPath,
        nodeModulesPath
      });
      if (restored) {
        cacheStatus = "hit";
        return;
      }
    }

    await progress(input.env, "dependency_cache_miss", "Dependency cache miss; installing with persistent npm cache.", {
      lockHash,
      cacheType: "dependencies",
      cacheStatus: "miss",
      reason: input.reason
    });
    await runCommand("npm", ["ci", "--cache", input.cache.npmCacheDir, "--prefer-offline", "--no-audit", "--fund=false"], {
      cwd: input.checkoutDir,
      taskEnv: input.env,
      step: "dependencies"
    });
    const tempCachePath = path.join(input.cache.nodeModulesDir, `.tmp-${lockHash}-${randomUUID()}`);
    await fs.rm(tempCachePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(nodeModulesPath, tempCachePath, { recursive: true });
    await fs.rename(tempCachePath, cachedNodeModulesPath).catch(async (error: NodeJS.ErrnoException) => {
      await fs.rm(tempCachePath, { recursive: true, force: true }).catch(() => undefined);
      if (error.code !== "EEXIST") throw error;
    });
  });
  return { cacheStatus, lockHash };
}

async function restoreCachedNodeModules(input: {
  env: SandboxEnv;
  lockHash: string;
  reason?: string;
  cachedNodeModulesPath: string;
  nodeModulesPath: string;
}) {
  await progress(input.env, "dependency_cache_hit", "Restoring node_modules from the dependency cache.", {
    lockHash: input.lockHash,
    cacheType: "dependencies",
    cacheStatus: "hit",
    reason: input.reason
  });
  await fs.rm(input.nodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
  try {
    await fs.cp(input.cachedNodeModulesPath, input.nodeModulesPath, { recursive: true });
    return true;
  } catch (error) {
    await fs.rm(input.nodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(input.cachedNodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
    await progress(input.env, "dependency_cache_restore_failed", "Dependency cache restore failed; rebuilding cache with npm ci.", {
      lockHash: input.lockHash,
      cacheType: "dependencies",
      cacheStatus: "corrupt",
      reason: input.reason,
      error: conciseError(error)
    }).catch(() => undefined);
    return false;
  }
}

async function dependencyCacheKey(checkoutDir: string) {
  const [lockfile, packageJson] = await Promise.all([
    fs.readFile(path.join(checkoutDir, "package-lock.json")),
    fs.readFile(path.join(checkoutDir, "package.json"))
  ]);
  return `${process.version.replace(/^v/, "node-")}-${sha256Buffer(Buffer.concat([lockfile, packageJson])).slice(0, 24)}`;
}

async function readDependencyManifestState(checkoutDir: string): Promise<Record<string, string | null>> {
  const files = ["package.json", "package-lock.json"];
  const entries = await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(checkoutDir, file);
      if (!(await pathExists(filePath))) return [file, null] as const;
      return [file, sha256Buffer(await fs.readFile(filePath))] as const;
    })
  );
  return Object.fromEntries(entries);
}

function changedDependencyManifestFiles(before: Record<string, string | null>, after: Record<string, string | null>) {
  return Object.keys({ ...before, ...after }).filter((file) => before[file] !== after[file]);
}

async function removeCachedWorktree(mirrorDir: string, checkoutDir: string) {
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

async function pruneOldWorkspaceDirs(workspacesDir: string) {
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

async function withDirectoryLock<T>(lockDir: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const staleAfterMs = 10 * 60 * 1000;
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const stat = await fs.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleAfterMs) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > staleAfterMs) throw new Error(`Timed out waiting for cache lock ${lockDir}`);
      await sleep(500);
    }
  }

  try {
    return await run();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function progress(env: SandboxEnv, step: string, message: string, metadata: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event: "task.progress", taskId: env.taskId, step, message, metadata }));
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/events`, { step, message, metadata });
}

async function complete(env: SandboxEnv, body: Record<string, unknown>) {
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {};
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/complete`, {
    ...body,
    metadata: { sandboxRunId: env.sandboxRunId, ...metadata }
  });
}

async function postJson(env: SandboxEnv, pathName: string, body: Record<string, unknown>) {
  const response = await fetch(`${env.controlPlaneInternalUrl}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.taskToken}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Control-plane callback failed (${response.status}): ${await response.text()}`);
  }
}

function parseGitHubRepository(repository: string) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY "${repository}". Expected owner/repo.`);
  return { owner, repo };
}

function codeUpdateBranchName(title: string) {
  const slug = slugify(title).slice(0, 48) || "agent-update";
  return `discord-ai-agent/update-${slug}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function gitAuthEnv(token: string, workRoot: string): Promise<NodeJS.ProcessEnv> {
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

function codexEnv(env: SandboxEnv, baseEnv: NodeJS.ProcessEnv, workRoot: string, toolShimDir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CODEX_HOME: path.join(workRoot, ".codex"),
    OPENROUTER_API_KEY: env.openRouterApiKey,
    PATH: `${toolShimDir}${path.delimiter}${baseEnv.PATH ?? process.env.PATH ?? ""}`,
    AGENT_TOOL_SHIM_DIR: toolShimDir
  };
}

async function writeSandboxToolShims(toolShimDir: string): Promise<string[]> {
  await fs.mkdir(toolShimDir, { recursive: true });
  const shims = {
    "agent-task-context": [
      "#!/bin/sh",
      "cat <<EOF",
      "Task ID: ${TASK_ID}",
      "Trace ID: ${TRACE_ID}",
      "Requested by: ${REQUESTED_BY}",
      "Repository: ${GITHUB_REPOSITORY}",
      "Base branch: ${GITHUB_BASE_BRANCH}",
      "Cache dir: ${SANDBOX_CACHE_DIR}",
      "EOF",
      ""
    ].join("\n"),
    "agent-cache-info": [
      "#!/bin/sh",
      "set -eu",
      "cache_dir=${SANDBOX_CACHE_DIR:-}",
      "if [ -z \"$cache_dir\" ]; then",
      "  echo 'SANDBOX_CACHE_DIR is not set'",
      "  exit 0",
      "fi",
      "echo \"Cache dir: $cache_dir\"",
      "for name in repos npm node_modules locks; do",
      "  path=\"$cache_dir/$name\"",
      "  if [ -e \"$path\" ]; then",
      "    count=$(find \"$path\" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')",
      "    echo \"$name: $count entries\"",
      "  else",
      "    echo \"$name: missing\"",
      "  fi",
      "done",
      ""
    ].join("\n"),
    "agent-progress": [
      "#!/bin/sh",
      "set -eu",
      "step=${1:-codex_note}",
      "if [ \"$#\" -gt 0 ]; then shift; fi",
      "message=${*:-Codex reported progress.}",
      "node -e '",
      "const [step, message] = process.argv.slice(1);",
      "const taskId = process.env.TASK_ID;",
      "const token = process.env.AGENT_TASK_TOKEN;",
      "const baseUrl = (process.env.CONTROL_PLANE_INTERNAL_URL || \"\").replace(/\\/$/, \"\");",
      "if (!taskId || !token || !baseUrl) { console.error(\"Missing task callback environment.\"); process.exit(1); }",
      "const url = `${baseUrl}/internal/tasks/${encodeURIComponent(taskId)}/events`;",
      "const body = JSON.stringify({ step, message, metadata: { source: \"agent-progress\" } });",
      "fetch(url, { method: \"POST\", headers: { \"content-type\": \"application/json\", authorization: `Bearer ${token}` }, body })",
      "  .then(async (response) => { if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`); })",
      "  .catch((error) => { console.error(error); process.exit(1); });",
      "' \"$step\" \"$message\"",
      ""
    ].join("\n")
  };
  await Promise.all(
    Object.entries(shims).map(async ([name, content]) => {
      await fs.writeFile(path.join(toolShimDir, name), content, { encoding: "utf8", mode: 0o755 });
    })
  );
  return Object.keys(shims);
}

async function writeCodexConfig(workRoot: string, checkoutDir: string, env: SandboxEnv) {
  const codexHome = path.join(workRoot, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model = ${JSON.stringify(env.openRouterChatModel)}`,
      'model_provider = "openrouter"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'preferred_auth_method = "apikey"',
      'model_verbosity = "low"',
      "",
      "[model_providers.openrouter]",
      'name = "OpenRouter"',
      'base_url = "https://openrouter.ai/api/v1"',
      'env_key = "OPENROUTER_API_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "",
      `[projects.${JSON.stringify(checkoutDir)}]`,
      'trust_level = "trusted"',
      ""
    ].join("\n"),
    "utf8"
  );
}

type CodegenContextRule = CodegenContextPack;

const CODEGEN_CONTEXT_RULES: CodegenContextRule[] = [
  {
    focus: "agent_task_status_lifecycle",
    rationale:
      "The request appears to involve long-running code update tasks, progress messages, PR creation, sandbox execution, or a stuck user-facing status.",
    likelyMechanisms: [
      "Discord mentions start with a temporary reply that can be edited later.",
      "Code update tools enqueue an agent task and pass the Discord status message id to the task record.",
      "The task notifier renders queued/running/terminal task states back into the same Discord message.",
      "Terminal task rendering must cover success, failure, no-change, cancellation, and notification failure paths."
    ],
    suggestedFiles: [
      { path: "src/tools/coreTools.ts", reason: "Code update tool entry point, task enqueueing, and task result formatting." },
      { path: "src/discord/client.ts", reason: "Discord mention lifecycle, Thinking reply creation, status callback, and final/error edits." },
      { path: "src/discord/taskNotifications.ts", reason: "Background agent task progress and terminal Discord message rendering." },
      { path: "src/db/repositories.ts", reason: "Agent task state transitions, render eligibility, and terminal render bookkeeping." },
      { path: "src/jobs/queue.ts", reason: "Agent task queue creation and job metadata passed to the execution backend." },
      { path: "tests/unit/task-notifications.test.ts", reason: "Focused tests for task rendering and notification behavior." },
      { path: "tests/unit/core-tools.test.ts", reason: "Focused tests for code update tool output and enqueue behavior." },
      { path: "tests/unit/discord-client.test.ts", reason: "Focused tests for Discord message handling and temporary reply lifecycle." }
    ],
    firstInvariant:
      "A long-running code update request should move the same Discord status message from acknowledgement/progress to one terminal success/failure/no-changes/cancelled state, without leaving stale loading/progress text after completion.",
    suggestedFirstEdit:
      "Start by adding or updating a focused task notification/repository test that proves a terminal code-update task can still replace stale progress text after an earlier render/status problem, then make the smallest repository/notifier change that satisfies it.",
    avoid: [
      "Do not search only for the literal phrase from the user request; map product wording to the status reply/task notifier mechanism.",
      "Do not replace the status message id contract unless the notifier is updated to use the new contract.",
      "Do not change unrelated Discord history/search/tool behavior."
    ]
  },
  {
    focus: "discord_interaction_lifecycle",
    rationale:
      "The request appears to involve Discord mention handling, replies, message edits, timeouts, content filters, or conversation memory.",
    likelyMechanisms: [
      "A Discord mention is persisted, acknowledged, processed by the model-led agent, then edited into a final reply.",
      "Worker-backed Discord requests fetch the source message and acknowledgement reply before executing the same agent path.",
      "Failure and timeout paths edit the acknowledgement message and update process run state."
    ],
    suggestedFiles: [
      { path: "src/discord/client.ts", reason: "Primary Discord mention, reply, timeout, and error lifecycle." },
      { path: "src/agent/router.ts", reason: "Model/tool loop, final response selection, and direct terminal tool handling." },
      { path: "src/tools/coreTools.ts", reason: "Local tool implementations that may affect Discord-visible responses." },
      { path: "tests/unit/discord-client.test.ts", reason: "Focused Discord adapter tests." },
      { path: "tests/integration/agent.test.ts", reason: "Agent/tool behavior tests across model rounds and responses." }
    ],
    firstInvariant:
      "A Discord mention should produce exactly one coherent user-visible response path for success, direct terminal tools, content filters, errors, and timeouts.",
    suggestedFirstEdit:
      "Start by adding or updating the closest Discord client or agent integration test for the visible response path, then adjust the shared request lifecycle rather than only one caller.",
    avoid: [
      "Do not fork inline and worker-backed request behavior unless both paths remain covered.",
      "Do not treat an earlier assistant reply or memory artifact as authoritative Discord history."
    ]
  },
  {
    focus: "model_tool_routing",
    rationale:
      "The request appears to involve model-led tool choice, Discord search/stat tools, web tools, prompt behavior, or final-answer synthesis.",
    likelyMechanisms: [
      "The agent prompt describes when to call local Discord tools versus hosted OpenRouter tools.",
      "The router selects usable local tool calls, executes them, stores tool evidence, then synthesizes a final answer.",
      "Tool schema descriptions are part of the model contract and often matter as much as implementation code."
    ],
    suggestedFiles: [
      { path: "src/agent/router.ts", reason: "Model-led tool loop, system prompt, recovery behavior, and final synthesis." },
      { path: "src/tools/registry.ts", reason: "Tool definitions, schemas, and descriptions exposed to the model." },
      { path: "src/tools/coreTools.ts", reason: "Tool implementations and result formatting." },
      { path: "tests/integration/agent.test.ts", reason: "Agent routing and final-answer regression tests." },
      { path: "tests/unit/tool-registry.test.ts", reason: "Tool schema surface tests." },
      { path: "tests/unit/core-tools.test.ts", reason: "Tool implementation tests." }
    ],
    firstInvariant:
      "For a model-led tool behavior change, the schema/prompt/tool result should make the intended tool choice natural without adding hidden message-specific branching.",
    suggestedFirstEdit:
      "Start by adding or updating an agent/tool-registry regression test that demonstrates the desired model-led tool choice or tool output contract.",
    avoid: [
      "Do not add semantic regex branches for one user phrasing when a tool schema or prompt contract should carry the behavior.",
      "Do not make Discord history search the default for public/current external facts."
    ]
  },
  {
    focus: "general_implementation",
    rationale:
      "No narrower codegen context matched confidently, so start from the common agent entry points and nearest tests.",
    likelyMechanisms: [
      "Most user-visible behavior enters through the Discord adapter, model router, tool registry, or core tool implementations.",
      "Tests are organized around the affected adapter/tool/runtime boundary."
    ],
    suggestedFiles: [
      { path: "src/discord/client.ts", reason: "Discord-facing behavior and request lifecycle." },
      { path: "src/agent/router.ts", reason: "Model-led agent behavior and final response synthesis." },
      { path: "src/tools/registry.ts", reason: "Tool descriptions and schemas." },
      { path: "src/tools/coreTools.ts", reason: "Tool implementations." },
      { path: "tests/integration/agent.test.ts", reason: "End-to-end model/tool behavior tests." }
    ],
    firstInvariant:
      "Turn the requested behavior into one focused observable invariant, implement the smallest code path that satisfies it, then broaden only to touched callers and failure paths.",
    suggestedFirstEdit:
      "Start by adding or updating the closest existing test around the likely entry point before broad repository exploration.",
    avoid: ["Do not start with broad repository-wide exploration when a likely entry point is available."]
  }
];

export async function buildCodegenContextPack(checkoutDir: string, taskRequest: string): Promise<CodegenContextPack> {
  const rule = selectCodegenContextRule(taskRequest);
  return {
    ...rule,
    suggestedFiles: await filterExistingSuggestedFiles(checkoutDir, rule.suggestedFiles)
  };
}

function selectCodegenContextRule(taskRequest: string): CodegenContextRule {
  const text = taskRequest.toLowerCase();
  const hasCodeUpdateTerm = includesAny(text, [
    "code update",
    "coding agent",
    "codegen",
    "sandbox",
    "pull request",
    " pr",
    "github",
    "update itself",
    "update yourself",
    "self-update",
    "self update",
    "agent task"
  ]);
  const hasStatusTerm = includesAny(text, ["loading", "thinking", "status", "progress", "stuck", "hang", "finish", "done", "complete"]);
  if (hasCodeUpdateTerm || (hasStatusTerm && includesAny(text, ["code", "agent", "bot", "request"]))) {
    return CODEGEN_CONTEXT_RULES[0];
  }

  if (includesAny(text, ["discord", "mention", "reply", "message", "timeout", "content filter", "conversation", "memory"])) {
    return CODEGEN_CONTEXT_RULES[1];
  }

  if (includesAny(text, ["tool", "search", "history", "web", "model", "prompt", "router", "schema", "stats"])) {
    return CODEGEN_CONTEXT_RULES[2];
  }

  return CODEGEN_CONTEXT_RULES[3];
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

async function filterExistingSuggestedFiles(checkoutDir: string, files: CodegenContextPack["suggestedFiles"]) {
  const existing: CodegenContextPack["suggestedFiles"] = [];
  for (const file of files) {
    if (await pathExists(path.join(checkoutDir, file.path))) existing.push(file);
  }
  return existing.length > 0 ? existing : files;
}

export function renderCodegenContextPack(contextPack: CodegenContextPack) {
  return [
    `Focus: ${contextPack.focus}`,
    "",
    `Why this context: ${contextPack.rationale}`,
    "",
    "Likely mechanisms:",
    ...contextPack.likelyMechanisms.map((mechanism) => `- ${mechanism}`),
    "",
    "Suggested first files:",
    ...contextPack.suggestedFiles.map((file) => `- ${file.path}: ${file.reason}`),
    "",
    "First implementable invariant:",
    contextPack.firstInvariant,
    "",
    "Suggested first edit:",
    contextPack.suggestedFirstEdit,
    "",
    "Avoid:",
    ...contextPack.avoid.map((warning) => `- ${warning}`)
  ].join("\n");
}

export function codeUpdatePrompt(env: Pick<SandboxEnv, "taskId" | "requestedBy" | "taskRequest">, contextPack?: CodegenContextPack) {
  return [
    "You are implementing a Discord-requested update to this TypeScript Discord AI Agent repository.",
    "",
    "Working style:",
    "- Move like a senior maintainer: understand just enough, make the smallest coherent change, then validate it.",
    "- Do not ask follow-up questions. When the request has multiple plausible interpretations, choose the one that preserves existing workflows and makes the requested behavior true.",
    "- Do not commit, push, open a PR, or edit GitHub state yourself.",
    "- Do not add request-only documentation artifacts; the PR body records the request.",
    ...(contextPack
      ? [
          "",
          "Codegen preflight context:",
          renderCodegenContextPack(contextPack),
          "",
          "Use the preflight context as a starting map, not as proof. Inspect the suggested first files before broad searching, then make the suggested first edit and first implementable invariant true."
        ]
      : []),
    "",
    "Implementation workflow:",
    "- First inspection pass: read the likely entry point, the closest existing helper/adapter, and the closest tests. Avoid broad repository archaeology before the first edit.",
    "- User wording may describe product behavior instead of exact code symbols. If literal searches miss, map the phrase to the closest existing mechanism in the lifecycle, such as a Discord reply edit, status callback, reaction, queue state, or persisted run status.",
    "- If the request changes user-visible behavior, map the lifecycle before editing: trigger -> temporary state -> progress/update paths -> success response -> error/timeout/cancellation -> cleanup.",
    "- If the behavior spans more than one path, introduce or reuse a small abstraction that owns the lifecycle instead of patching each call site independently.",
    "- Preserve existing invariants that other code may depend on. If replacing a visible mechanism, keep any underlying state or callback contract intact unless the request explicitly says to remove it.",
    "- For bug fixes, encode the requested behavior as a focused invariant in code or tests early. Do not conclude that existing behavior is fine merely because the first matching path appears intentional.",
    "- Make a focused first edit after the likely lifecycle owner is identified, then run `agent-progress first_edit \"Made the first focused code edit\"`.",
    "- After the first edit, broaden the search only to cover callers, failure paths, and tests touched by that lifecycle.",
    "- Add or update tests for the changed behavior, including cleanup/fallback/error paths when the request affects temporary state or external APIs.",
    "- Run targeted checks first, then the most relevant broader check you can before finishing.",
    "",
    "Stall avoidance:",
    "- Do not repeatedly reread the same file or expand into unrelated UI, observability, deployment, or queue code unless the lifecycle map shows it is required.",
    "- After a few targeted searches, stop searching for exact request vocabulary and act on the closest mechanism you found.",
    "- If stuck, implement the smallest safe version that preserves existing contracts, add a focused test, and leave uncertainty only where it helps future maintainers.",
    "- The sandbox monitors for a first diff. Produce a real code diff promptly; pure analysis without edits will be stopped and retried.",
    "",
    "Available helper CLIs:",
    "- `agent-task-context` prints task metadata.",
    "- `agent-cache-info` prints sandbox cache information.",
    "- `agent-progress <step> <message>` records progress in the run console.",
    "",
    `Task ID: ${env.taskId}`,
    `Requested by: ${env.requestedBy}`,
    "",
    "Requested update:",
    env.taskRequest.trim(),
    ""
  ].join("\n");
}

export function codexExecArgs(input: { checkoutDir: string; model: string }) {
  return [
    "exec",
    "--ephemeral",
    "-C",
    input.checkoutDir,
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    input.model,
    "-"
  ];
}

function codegenWatchdog(): CommandWatchdog {
  return {
    kind: "codex",
    noFirstDiffTimeoutMs: CODEX_NO_FIRST_DIFF_TIMEOUT_MS,
    idleTimeoutMs: CODEX_IDLE_TIMEOUT_MS,
    reconnectStallTimeoutMs: CODEX_RECONNECT_STALL_TIMEOUT_MS,
    maxRuntimeMs: CODEX_MAX_RUNTIME_MS
  };
}

export function evaluateCodegenWatchdog(input: CodegenWatchdogInput): CodegenWatchdogDecision | null {
  const noFirstDiffTimeoutMs = input.noFirstDiffTimeoutMs ?? CODEX_NO_FIRST_DIFF_TIMEOUT_MS;
  const idleTimeoutMs = input.idleTimeoutMs ?? CODEX_IDLE_TIMEOUT_MS;
  const reconnectStallTimeoutMs = input.reconnectStallTimeoutMs ?? CODEX_RECONNECT_STALL_TIMEOUT_MS;
  const maxRuntimeMs = input.maxRuntimeMs ?? CODEX_MAX_RUNTIME_MS;

  if (!input.hasDiff && input.elapsedMs >= noFirstDiffTimeoutMs) {
    return {
      action: "fail",
      reason: "no_first_diff",
      message: `Codex produced no code diff after ${formatDuration(input.elapsedMs)}; stopping early so this can be retried with a narrower implementation pass.`
    };
  }

  if (input.reconnectSeen && input.reconnectStallMs != null && input.reconnectStallMs >= reconnectStallTimeoutMs) {
    return {
      action: input.hasDiff ? "continue" : "fail",
      reason: "reconnect_stall",
      message: input.hasDiff
        ? "Codex stalled after a reconnect but already produced a code diff; stopping Codex and continuing to verification."
        : "Codex stalled after a reconnect before producing a code diff; stopping early so this can be retried."
    };
  }

  if (input.idleMs >= idleTimeoutMs) {
    return {
      action: input.hasDiff ? "continue" : "fail",
      reason: input.hasDiff ? "idle_after_diff" : "idle_before_diff",
      message: input.hasDiff
        ? "Codex stopped producing output after creating a code diff; stopping Codex and continuing to verification."
        : "Codex stopped producing output before creating a code diff; stopping early so this can be retried."
    };
  }

  if (input.elapsedMs >= maxRuntimeMs) {
    return {
      action: input.hasDiff ? "continue" : "fail",
      reason: "max_runtime",
      message: input.hasDiff
        ? `Codex reached ${formatDuration(input.elapsedMs)} with a code diff; stopping Codex and continuing to verification.`
        : `Codex reached ${formatDuration(input.elapsedMs)} without a code diff; stopping before the Kubernetes deadline.`
    };
  }

  return null;
}

function pullRequestBody(input: { env: SandboxEnv; verifyPassed: boolean; timings: TaskTimings; cacheSummary: CacheSummary }) {
  return [
    `Prompted by: ${input.env.requestedBy}`,
    "",
    "## Requested Update",
    "",
    input.env.taskRequest.trim(),
    "",
    "## Agent Task",
    "",
    `- Task ID: \`${input.env.taskId}\``,
    `- Sandbox run: \`${input.env.sandboxRunId}\``,
    "- Runtime: Kubernetes sandbox job",
    `- Model: \`${input.env.openRouterChatModel}\``,
    "",
    "## Verification",
    "",
    `- \`npm run verify\`: ${input.verifyPassed ? "passed" : "failed; opened as draft"}`,
    "- `npm run scan:release`: passed",
    "",
    "## Timing",
    "",
    ...formatTimingLines(input.timings),
    "",
    "## Cache",
    "",
    ...formatCacheSummaryLines(input.cacheSummary)
  ].join("\n");
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    allowFailure?: boolean;
    taskEnv?: SandboxEnv;
    step?: string;
    watchdog?: CommandWatchdog;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  console.log(JSON.stringify({ event: "sandbox.command.start", command, args: redactedArgs(command, args), cwd: options.cwd }));
  const startedAt = Date.now();
  const step = options.step ?? command;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  const commandLine = `${command} ${redactedArgs(command, args).join(" ")}`.trim();
  let childClosed = false;
  const watchdogOutcome: { current: { decision: CodegenWatchdogDecision; metadata: Record<string, unknown> } | null } = { current: null };
  const watchdogState = {
    lastStdoutChars: 0,
    lastStderrChars: 0,
    lastOutputChangedAt: startedAt,
    reconnectSeenAt: null as number | null,
    reconnectOutputChangedAt: null as number | null,
    firstDiffAt: null as number | null,
    latestDiff: null as GitWorkingTreeSnapshot | null
  };

  const emitActivity = async () => {
    const now = Date.now();
    const outputChanged = stdout.length !== watchdogState.lastStdoutChars || stderr.length !== watchdogState.lastStderrChars;
    if (outputChanged) {
      watchdogState.lastStdoutChars = stdout.length;
      watchdogState.lastStderrChars = stderr.length;
      watchdogState.lastOutputChangedAt = now;
    }
    if (CODEX_RECONNECT_PATTERN.test(stdout) || CODEX_RECONNECT_PATTERN.test(stderr)) {
      watchdogState.reconnectSeenAt ??= now;
      if (outputChanged) watchdogState.reconnectOutputChangedAt = now;
    }

    if (options.watchdog?.kind === "codex") {
      watchdogState.latestDiff = await gitWorkingTreeSnapshot(options.cwd);
      if (watchdogState.latestDiff.hasDiff && watchdogState.firstDiffAt == null) {
        watchdogState.firstDiffAt = now;
        await progress(options.taskEnv!, "codex_first_diff", "Codex produced the first working tree diff.", {
          durationMs: now - startedAt,
          changedFiles: watchdogState.latestDiff.changedFiles,
          diffStat: tail(watchdogState.latestDiff.diffStat, 2000)
        }).catch(() => undefined);
      }

      const reconnectStallMs =
        watchdogState.reconnectSeenAt == null ? null : now - (watchdogState.reconnectOutputChangedAt ?? watchdogState.reconnectSeenAt);
      const decision = evaluateCodegenWatchdog({
        elapsedMs: now - startedAt,
        idleMs: now - watchdogState.lastOutputChangedAt,
        hasDiff: watchdogState.firstDiffAt != null,
        reconnectSeen: watchdogState.reconnectSeenAt != null,
        reconnectStallMs,
        noFirstDiffTimeoutMs: options.watchdog.noFirstDiffTimeoutMs,
        idleTimeoutMs: options.watchdog.idleTimeoutMs,
        reconnectStallTimeoutMs: options.watchdog.reconnectStallTimeoutMs,
        maxRuntimeMs: options.watchdog.maxRuntimeMs
      });

      if (decision) {
        const metadata = {
          command: commandLine,
          durationMs: now - startedAt,
          idleMs: now - watchdogState.lastOutputChangedAt,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stdoutTail: tail(stdout, MAX_ACTIVITY_COMMAND_OUTPUT),
          stderrTail: tail(stderr, MAX_ACTIVITY_COMMAND_OUTPUT),
          reconnectSeen: watchdogState.reconnectSeenAt != null,
          reconnectStallMs,
          firstDiffAtMs: watchdogState.firstDiffAt == null ? null : watchdogState.firstDiffAt - startedAt,
          changedFiles: watchdogState.latestDiff.changedFiles,
          diffStat: tail(watchdogState.latestDiff.diffStat, 4000),
          diffSnapshotError: watchdogState.latestDiff.error,
          decision
        };
        watchdogOutcome.current = { decision, metadata };
        await progress(options.taskEnv!, "codex_watchdog", decision.message, metadata).catch(() => undefined);
        await recordArtifact(options.taskEnv, {
          kind: "diagnostic",
          name: "Codex watchdog diagnosis",
          content: JSON.stringify(metadata, null, 2),
          contentType: "application/json",
          metadata: { reason: decision.reason, action: decision.action }
        });
        terminateChild(child, CODEX_TERMINATE_GRACE_MS, () => childClosed);
        return;
      }
    }

    await progress(options.taskEnv!, `${step}_activity`, `${step} is still running after ${formatDuration(now - startedAt)}.`, {
      command: commandLine,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
      stdoutTail: tail(stdout, MAX_ACTIVITY_COMMAND_OUTPUT),
      stderrTail: tail(stderr, MAX_ACTIVITY_COMMAND_OUTPUT),
      durationMs: now - startedAt,
      idleMs: now - watchdogState.lastOutputChangedAt,
      diff: watchdogState.latestDiff
        ? {
            hasDiff: watchdogState.latestDiff.hasDiff,
            changedFiles: watchdogState.latestDiff.changedFiles,
            diffStat: tail(watchdogState.latestDiff.diffStat, 2000),
            error: watchdogState.latestDiff.error
          }
        : undefined
    });
  };

  let activityRunning = false;
  const activityTimer =
    (options.taskEnv || options.watchdog) && shouldEmitCommandActivity(step)
      ? setInterval(() => {
          if (activityRunning || childClosed || watchdogOutcome.current) return;
          activityRunning = true;
          void emitActivity()
            .catch(() => undefined)
            .finally(() => {
              activityRunning = false;
            });
        }, options.watchdog?.activityIntervalMs ?? COMMAND_ACTIVITY_INTERVAL_MS)
      : undefined;
  activityTimer?.unref?.();

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });

  if (options.input) child.stdin.write(options.input);
  child.stdin.end();

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        childClosed = true;
        resolve(code ?? 1);
      });
    });
  } finally {
    if (activityTimer) clearInterval(activityTimer);
  }
  await recordCommand(options.taskEnv, {
    step,
    command: commandLine,
    exitCode,
    outputTail: tail(stdout, MAX_CAPTURED_COMMAND_OUTPUT),
    errorTail: tail(stderr, MAX_CAPTURED_COMMAND_OUTPUT),
    durationMs: Date.now() - startedAt
  });
  await recordArtifact(options.taskEnv, {
    kind: "command_log",
    name: `${step} command log`,
    content: [`$ ${commandLine}`, stdout.trimEnd(), stderr.trimEnd(), `[exit ${exitCode} in ${formatDuration(Date.now() - startedAt)}]`]
      .filter(Boolean)
      .join("\n"),
    contentType: "text/plain",
    metadata: { step, command: commandLine, exitCode, watchdog: watchdogOutcome.current?.decision ?? undefined }
  });
  const outcome = watchdogOutcome.current;
  if (outcome?.decision.action === "fail") {
    throw new CodegenWatchdogError(outcome.decision.message, outcome.decision, outcome.metadata);
  }
  if (outcome?.decision.action === "continue") {
    await progress(options.taskEnv!, "codex_watchdog_continue", "Continuing with the generated diff after stopping stalled Codex.", {
      ...outcome.metadata,
      exitCode
    }).catch(() => undefined);
    return { exitCode: 0, stdout, stderr };
  }
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}: ${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr };
}

async function recordCommand(
  env: SandboxEnv | undefined,
  body: {
    step: string;
    command: string;
    exitCode: number;
    outputTail: string;
    errorTail: string;
    durationMs: number;
  }
) {
  if (!env) return;
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/commands`, {
    sandboxRunId: env.sandboxRunId,
    ...body
  }).catch((error) => {
    console.error("Failed to post sandbox command event", error);
  });
}

async function gitWorkingTreeSnapshot(cwd: string): Promise<GitWorkingTreeSnapshot> {
  const status = await execFileText("git", ["status", "--porcelain"], cwd);
  if (status.exitCode !== 0) {
    return {
      hasDiff: false,
      status: "",
      diffStat: "",
      changedFiles: [],
      error: status.stderr || status.stdout || `git status exited ${status.exitCode}`
    };
  }
  const statusText = status.stdout.trim();
  const changedFiles = statusText
    ? statusText
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    : [];
  const diffStat = statusText ? await execFileText("git", ["diff", "--stat"], cwd) : null;
  return {
    hasDiff: Boolean(statusText),
    status: statusText,
    diffStat: diffStat?.stdout.trim() ?? "",
    changedFiles,
    error: diffStat && diffStat.exitCode !== 0 ? diffStat.stderr || diffStat.stdout || `git diff --stat exited ${diffStat.exitCode}` : undefined
  };
}

function execFileText(command: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 200_000 }, (error, stdout, stderr) => {
      const exitCode =
        error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? Number((error as NodeJS.ErrnoException & { code: number }).code)
          : error
            ? 1
            : 0;
      resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function terminateChild(child: ReturnType<typeof spawn>, graceMs: number, isClosed: () => boolean) {
  if (child.killed) return;
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (!isClosed()) child.kill("SIGKILL");
  }, graceMs);
  forceKill.unref?.();
}

async function recordArtifact(
  env: SandboxEnv | undefined,
  body: {
    kind:
      | "prompt"
      | "command_log"
      | "diff"
      | "pr_body"
      | "model_transcript"
      | "tool_transcript"
      | "crawl_summary"
      | "embedding_summary"
      | "raw_json"
      | "response"
      | "diagnostic";
    name: string;
    content: string;
    contentType: string;
    metadata?: Record<string, unknown>;
  }
) {
  if (!env) return;
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/artifacts`, body).catch((error) => {
    console.error("Failed to post sandbox artifact", error);
  });
}

function tail(value: string, maxChars: number) {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function conciseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 500) ?? "unknown error";
}

function formatTimingLines(timings: TaskTimings) {
  const ordered = [
    ["sandbox acquisition/startup", timings.sandboxStartup],
    ["repo refresh / checkout", timings.repo],
    ["dependency prep", timings.dependencies],
    ["tool shim setup", timings.toolShims],
    ["Codex execution", timings.codex],
    ["post-Codex dependency prep", timings.dependenciesPostCodex],
    ["verification", timings.verify],
    ["scan", timings.scan],
    ["git push", timings.push],
    ["PR creation", timings.pr],
    ["total", timings.total]
  ] as const;
  return ordered
    .filter(([, value]) => typeof value === "number")
    .map(([label, value]) => `- ${label}: ${formatDuration(value ?? 0)}`);
}

function formatCacheSummaryLines(cache: CacheSummary) {
  const lines = [
    `- repository mirror: ${cache.repo ?? "unknown"}`,
    `- dependencies: ${cache.dependencies ?? "unknown"}${cache.dependencyCacheKey ? ` (${cache.dependencyCacheKey})` : ""}`
  ];
  if (cache.dependencyFilesChanged?.length) {
    lines.push(`- dependency files changed after Codex: ${cache.dependencyFilesChanged.join(", ")}`);
  }
  if (cache.dependencyRefreshAfterCodex) {
    lines.push("- dependencies refreshed after Codex before verification");
  }
  if (cache.toolShims?.length) {
    lines.push(`- sandbox helper tools: ${cache.toolShims.join(", ")}`);
  }
  return lines;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function shouldEmitCommandActivity(step: string) {
  return step === "codex" || step === "verify" || step === "scan" || step === "dependencies";
}

function redactedArgs(command: string, args: string[]) {
  if (command === "git" && args[0] === "clone") {
    return args.map((arg) => arg.replace(/x-access-token:[^@]+@/g, "x-access-token:[redacted]@"));
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
