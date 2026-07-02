import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { CodexAppServerClient, providerForModel, type CodexAppServerNotification } from "./codexAppServer.js";
import { slugify } from "../util/text.js";

const MAX_CAPTURED_COMMAND_OUTPUT = 40_000;
const MAX_ACTIVITY_COMMAND_OUTPUT = 12_000;
const MAX_CONTEXT_TEXT = 16_000;
const MAX_RECOVERY_TAIL = 10_000;
const MAX_CODEGEN_ANCHORS = 12;
const MAX_ANCHOR_MATCHES_PER_ANCHOR = 5;
const MAX_ANCHOR_MATCHES_TOTAL = 30;
const MAX_ANCHOR_TARGET_FILES = 8;
const MAX_ANCHOR_SCAN_FILE_BYTES = 512_000;
const STALE_WORKSPACE_MS = 6 * 60 * 60 * 1000;
const CODEX_APP_SERVER_MAX_ATTEMPTS = 2;
const CODEX_EXEC_FALLBACK_MAX_ATTEMPTS = 1;
const CODEX_FIRST_DIFF_DEADLINE_MS = 10 * 60_000;
const CODEX_FIRST_DIFF_RECOVERY_DEADLINE_MS = 10 * 60_000;
const CODEX_ANCHORED_FIRST_DIFF_DEADLINE_MS = 10 * 60_000;
const CODEX_ANCHORED_FIRST_DIFF_RECOVERY_DEADLINE_MS = 10 * 60_000;
const CODEX_IDLE_WITHOUT_DIFF_MS = 6 * 60 * 1000;
const CODEX_RECONNECT_STALL_MS = 3 * 60 * 1000;
const CODEX_MAX_RUNTIME_MS = 25 * 60 * 1000;
const CODEX_WATCHDOG_POLL_MS = 15_000;
const CODEX_RECONNECT_PATTERN = /(?:^|\n)ERROR:\s*Reconnecting\.\.\./i;
const CODE_UPDATE_BRANCH_PREFIX = "ai";
const CODE_UPDATE_BRANCH_SLUG_MAX_CHARS = 40;
const CODE_UPDATE_BRANCH_SUFFIX_CHARS = 4;
const CODE_UPDATE_BRANCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "can",
  "for",
  "from",
  "in",
  "instead",
  "of",
  "on",
  "or",
  "please",
  "the",
  "to",
  "with",
  "you"
]);
const DEPENDENCY_CACHE_MODE = "devdeps-v1";

type CodegenHarness = "codex" | "opencode";

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
  openRouterCodegenModel: string;
  codegenHarness: CodegenHarness;
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

export type CodegenContextPack = {
  repoGuidePath?: string;
  requestAnchors?: string[];
  anchorMatches?: CodegenAnchorMatch[];
  anchorTargetFiles?: Array<{ path: string; reason: string }>;
  focus?: string;
  rationale?: string;
  likelyMechanisms?: string[];
  suggestedFiles?: Array<{ path: string; reason: string }>;
  firstInvariant?: string;
  suggestedFirstEdit?: string;
  avoid?: string[];
  sandboxContract: string[];
  firstMoveRules: string[];
  projectMap: Array<{
    area: string;
    purpose: string;
    files: string[];
    checks: string[];
  }>;
};

type CodegenAnchorMatch = {
  anchor: string;
  file: string;
  line: number;
  preview: string;
};

type CodexAttemptSummary = {
  attempt: number;
  command: "app-server" | "exec" | "resume" | "opencode-run";
  exitCode: number;
  durationMs: number;
  producedDiff: boolean;
  watchdogReason?: string;
  stdoutTail: string;
  stderrTail: string;
};

type CodexRunSummary = {
  attempts: CodexAttemptSummary[];
};

type CodexWatchdogOptions = {
  checkoutDir: string;
  attempt: number;
  totalAttempts: number;
  firstDiffDeadlineMs?: number;
  firstDiffStep?: string;
  firstDiffMessage?: string;
  watchdogStepPrefix?: string;
  idleWithoutDiffMs?: number;
  reconnectStallMs?: number;
  maxRuntimeMs?: number;
  pollMs?: number;
};

type CodexWatchdogResult = {
  killed: boolean;
  reason?: string;
  durationMs?: number;
  firstDiffSeenAtMs?: number;
  lastOutputAtMs?: number;
};

type CodexAppServerAttemptResult = {
  exitCode: number;
  threadId?: string;
  terminalMethod?: string;
  durationMs: number;
  notifications: CodexAppServerNotification[];
  transcript: string;
  stderrTail: string;
  error?: string;
  startedTurn: boolean;
  watchdog?: CodexWatchdogResult;
};

type OpenCodeServerState = {
  child: ReturnType<typeof spawn>;
  serverUrl: string;
  commandLine: string;
  startedAt: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

class CodegenNoDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodegenNoDiffError";
  }
}

class CodexAppServerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerStartupError";
  }
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  watchdog?: CodexWatchdogResult;
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
    await complete(env, {
      status: message.includes("produced no diff") ? "no_changes" : "failed",
      error: message,
      metadata: { timingsMs: timings }
    }).catch((callbackError) => {
      console.error("Failed to post terminal task callback", callbackError);
    });
    throw error;
  }
}

async function runCodeUpdate(env: SandboxEnv, timings: TaskTimings, totalStartedAt: number) {
  const { owner, repo } = parseGitHubRepository(env.githubRepository);
  const prTitle = codeUpdatePullRequestTitle(env.taskTitle);
  const branchName = codeUpdateBranchName(prTitle, env.taskId);
  const cache = sandboxCachePaths(env, owner, repo);
  const cacheSummary: CacheSummary = {};
  await fs.mkdir(cache.workspacesDir, { recursive: true });
  await pruneOldWorkspaceDirs(cache.workspacesDir).catch((error) => {
    console.error("Failed to prune old sandbox workspaces", error);
  });
  const workRoot = await fs.mkdtemp(path.join(cache.workspacesDir, "task-"));
  const codexHome = codexHomePathForTask({ sandboxCacheDir: cache.rootDir, workRoot });
  const opencodeHome = path.join(workRoot, "opencode-home");
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
    await timedPhase(env, timings, "toolShims", "Installing sandbox helper tool shims for the codegen harness.", async () => {
      const shims = await writeSandboxToolShims(toolShimDir);
      cacheSummary.toolShims = shims;
      await progress(env, "tool_shims_ready", "Sandbox helper tools are available for the codegen harness.", { toolShims: shims, harness: env.codegenHarness });
    });

    await progress(env, "configure", `Writing ephemeral ${codegenHarnessDisplayName(env.codegenHarness)} configuration.`, { harness: env.codegenHarness });
    if (env.codegenHarness === "opencode") await writeOpenCodeConfig(opencodeHome, env);
    else await writeCodexConfig(codexHome, checkoutDir, env);

    const contextPack = await timedPhase(env, timings, "context", "Building codegen request context.", async () =>
      buildCodegenContextPack(checkoutDir, env.taskRequest)
    );
    const renderedContextPack = renderCodegenContextPack(contextPack);
    await recordArtifact(env, {
      kind: "diagnostic",
      name: "Codegen request context",
      content: renderedContextPack,
      contentType: "text/plain",
      metadata: {
        focus: contextPack.focus,
        files: uniqueStrings([
          ...(contextPack.suggestedFiles?.map((file) => file.path) ?? []),
          ...contextPack.projectMap.flatMap((entry) => entry.files)
        ])
      }
    });

    await runSelectedCodegenHarness({ env, timings, checkoutDir, gitEnv, workRoot, codexHome, opencodeHome, toolShimDir, contextPack });

    await progress(env, "diff", `Checking whether ${codegenHarnessDisplayName(env.codegenHarness)} produced a real code diff.`, { harness: env.codegenHarness });
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

    const npmScriptEnv = codegenNpmScriptEnv(process.env);
    const verify = await timedPhase(env, timings, "verify", "Running npm run verify on the generated changes.", async () =>
      runCommand("npm", ["run", "verify"], { cwd: checkoutDir, allowFailure: true, taskEnv: env, step: "verify", env: npmScriptEnv })
    );
    const scan = await timedPhase(env, timings, "scan", "Running release scan before pushing generated changes.", async () =>
      runCommand("npm", ["run", "scan:release"], { cwd: checkoutDir, allowFailure: true, taskEnv: env, step: "scan", env: npmScriptEnv })
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
    await runCommand("git", ["config", "commit.gpgsign", "false"], { cwd: checkoutDir, taskEnv: env, step: "commit" });
    await runCommand("git", ["add", "-A"], { cwd: checkoutDir, taskEnv: env, step: "commit" });
    await runCommand("git", ["commit", "-m", prTitle], {
      cwd: checkoutDir,
      taskEnv: env,
      step: "commit"
    });
    await timedPhase(env, timings, "push", "Pushing the generated branch to GitHub.", async () => {
      await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: checkoutDir, env: gitEnv, taskEnv: env, step: "push" });
    }, { branchName });

    const draft = verify.exitCode !== 0;
    const octokit = new Octokit({ auth: env.githubToken });
    const initialPrBody = codeUpdatePullRequestBody({ env, verifyPassed: verify.exitCode === 0 });
    const pr = await timedPhase(env, timings, "pr", "Opening the GitHub pull request.", async () =>
      octokit.pulls.create({
        owner,
        repo,
        title: prTitle,
        head: branchName,
        base: env.githubBaseBranch,
        draft,
        body: initialPrBody
      }), { draft }
    );

    timings.total = Date.now() - totalStartedAt;
    const finalPrBody = codeUpdatePullRequestBody({ env, verifyPassed: verify.exitCode === 0 });
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
    await fs.rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
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
    openRouterCodegenModel: process.env.OPENROUTER_CODEGEN_MODEL?.trim() || requiredEnv("OPENROUTER_CHAT_MODEL"),
    codegenHarness: codegenHarnessFromEnv(process.env.CODEGEN_HARNESS),
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

function codegenHarnessFromEnv(value: string | undefined): CodegenHarness {
  if (!value || value === "codex") return "codex";
  if (value === "opencode") return "opencode";
  throw new Error(`Invalid CODEGEN_HARNESS "${value}". Expected "codex" or "opencode".`);
}

function codegenHarnessDisplayName(harness: CodegenHarness) {
  return harness === "opencode" ? "OpenCode" : "Codex";
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

export function codexHomePathForTask(input: { sandboxCacheDir: string; workRoot: string }) {
  const taskDir = path.basename(input.workRoot) || `task-${sha256(input.workRoot).slice(0, 10)}`;
  return path.join(input.sandboxCacheDir, "codex-home", taskDir);
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
    await runCommand("npm", ["ci", "--include=dev", "--cache", input.cache.npmCacheDir, "--prefer-offline", "--no-audit", "--fund=false"], {
      cwd: input.checkoutDir,
      env: codegenNpmInstallEnv(process.env),
      taskEnv: input.env,
      step: "dependencies"
    });
    const tempCachePath = path.join(input.cache.nodeModulesDir, `.tmp-${lockHash}-${randomUUID()}`);
    await fs.rm(tempCachePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(nodeModulesPath, tempCachePath, { recursive: true, verbatimSymlinks: true });
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
    await fs.cp(input.cachedNodeModulesPath, input.nodeModulesPath, { recursive: true, verbatimSymlinks: true });
    await validateRestoredNodeModules(input.nodeModulesPath);
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

async function validateRestoredNodeModules(nodeModulesPath: string) {
  const requiredBins = [".bin/eslint", ".bin/tsc", ".bin/tsx", ".bin/vitest"];
  await Promise.all(
    requiredBins.map(async (relativePath) => {
      const binPath = path.join(nodeModulesPath, relativePath);
      const resolved = await fs.realpath(binPath);
      const relativeResolved = path.relative(nodeModulesPath, resolved);
      if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
        throw new Error(`Restored dependency cache contains non-portable bin symlink: ${relativePath} -> ${resolved}`);
      }
    })
  );
}

export async function dependencyCacheKey(checkoutDir: string) {
  const [lockfile, packageJson] = await Promise.all([
    fs.readFile(path.join(checkoutDir, "package-lock.json")),
    fs.readFile(path.join(checkoutDir, "package.json"))
  ]);
  return `${process.version.replace(/^v/, "node-")}-${DEPENDENCY_CACHE_MODE}-${sha256Buffer(Buffer.concat([lockfile, packageJson])).slice(0, 24)}`;
}

export function codegenNpmInstallEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.NODE_ENV;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_omit;
  delete env.NPM_CONFIG_OMIT;
  return {
    ...env,
    NODE_ENV: "development",
    npm_config_production: "false",
    NPM_CONFIG_PRODUCTION: "false"
  };
}

const CODEGEN_NPM_SCRIPT_ENV_PREFIXES = [
  "CODEGEN_",
  "CONTROL_",
  "CRAWL_",
  "DISCORD_",
  "GITHUB_",
  "KUBERNETES_",
  "OPENROUTER_",
  "RAILWAY_",
  "SANDBOX_",
  "WORKER_"
];

const CODEGEN_NPM_SCRIPT_ENV_KEYS = new Set([
  "BOT_NAME",
  "DATABASE_URL",
  "EMBEDDING_DIMENSIONS",
  "MAX_HISTORY_RESULTS",
  "MAX_REPLY_CHARS",
  "MAX_THREAD_SUMMARY_MESSAGES",
  "RUN_MIGRATIONS",
  "TASK_ID",
  "TASK_REQUEST",
  "TASK_SIGNING_SECRET",
  "TASK_TITLE",
  "TRACE_ID"
]);

export function codegenNpmScriptEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.NODE_ENV;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_omit;
  delete env.NPM_CONFIG_OMIT;
  for (const key of Object.keys(env)) {
    if (CODEGEN_NPM_SCRIPT_ENV_KEYS.has(key) || CODEGEN_NPM_SCRIPT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return {
    ...env,
    NODE_ENV: "development"
  };
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

async function gitStatusPorcelain(checkoutDir: string) {
  const result = await execFileText("git", ["status", "--porcelain"], { cwd: checkoutDir });
  return result.stdout;
}

function execFileText(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
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

export function codeUpdateBranchName(title: string, taskId?: string) {
  const suffix = codeUpdateBranchSuffix(taskId);
  const maxSlugChars = suffix
    ? Math.max(12, CODE_UPDATE_BRANCH_SLUG_MAX_CHARS - suffix.length - 1)
    : CODE_UPDATE_BRANCH_SLUG_MAX_CHARS;
  const slug = conciseBranchSlug(title, maxSlugChars) || "update";
  return `${CODE_UPDATE_BRANCH_PREFIX}/${suffix ? `${slug}-${suffix}` : slug}`;
}

export function codeUpdatePullRequestTitle(title: string) {
  const trimmed = title.trim().replace(/(?:--?retry)$/i, "").trim();
  const humanized = looksLikeKebabTitle(trimmed) ? trimmed.split("-").filter(Boolean).join(" ") : trimmed;
  const cleaned = humanized
    .replace(/\b(?:open|create|make)\s+(?:a\s+)?(?:github\s+)?(?:pull request|pr)\b[.!?]?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned) return "Agent update";
  return `${cleaned[0]?.toUpperCase() ?? ""}${cleaned.slice(1)}`;
}

function conciseBranchSlug(title: string, maxChars: number) {
  const words = slugify(codeUpdatePullRequestTitle(title))
    .split("-")
    .filter((word) => word && !CODE_UPDATE_BRANCH_STOP_WORDS.has(word));
  const slug = words.join("-") || slugify(title);
  return trimSlug(slug, maxChars);
}

function trimSlug(slug: string, maxChars: number) {
  if (slug.length <= maxChars) return slug;
  return slug.slice(0, maxChars).replace(/-[^-]*$/, "").replace(/^-+|-+$/g, "") || slug.slice(0, maxChars).replace(/^-+|-+$/g, "");
}

function codeUpdateBranchSuffix(taskId: string | undefined) {
  if (!taskId) return "";
  return taskId.replace(/[^a-z0-9]/gi, "").slice(-CODE_UPDATE_BRANCH_SUFFIX_CHARS).toLowerCase();
}

function looksLikeKebabTitle(value: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value);
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

function codexEnv(env: SandboxEnv, baseEnv: NodeJS.ProcessEnv, codexHome: string, toolShimDir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CODEX_HOME: codexHome,
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

async function writeCodexConfig(codexHome: string, checkoutDir: string, env: SandboxEnv) {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), codexConfigToml({ checkoutDir, model: env.openRouterCodegenModel }), "utf8");
}

async function runSelectedCodegenHarness(input: {
  env: SandboxEnv;
  timings: TaskTimings;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  workRoot: string;
  codexHome: string;
  opencodeHome: string;
  toolShimDir: string;
  contextPack: CodegenContextPack;
}) {
  if (input.env.codegenHarness === "opencode") {
    await timedPhase(
      input.env,
      input.timings,
      "opencode",
      "Running OpenCode to implement the requested change.",
      async () => {
        const summary = await runOpenCodeWithRecovery(input);
        await recordAgentAttemptSummary(input.env, "OpenCode attempt summary", summary, "opencode-server");
      },
      { model: openCodeModelId(input.env.openRouterCodegenModel), harness: "opencode-server" }
    );
    return;
  }

  await timedPhase(
    input.env,
    input.timings,
    "codex",
    "Running Codex to implement the requested change.",
    async () => {
      const summary = await runCodexWithRecovery(input);
      await recordAgentAttemptSummary(input.env, "Codex attempt summary", summary, "codex-app-server");
    },
    { model: input.env.openRouterCodegenModel, harness: "codex-app-server", fallbackHarness: "codex-exec-json" }
  );
}

async function recordAgentAttemptSummary(env: SandboxEnv, name: string, summary: CodexRunSummary, harness: string) {
  await recordArtifact(env, {
    kind: "diagnostic",
    name,
    content: JSON.stringify(summary, null, 2),
    contentType: "application/json",
    metadata: {
      harness,
      attempts: summary.attempts.length,
      producedDiff: summary.attempts.some((attempt) => attempt.producedDiff)
    }
  });
}

export function codexConfigToml(input: { checkoutDir: string; model: string }) {
  return [
    `model = ${JSON.stringify(input.model)}`,
    'model_provider = "openrouter"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'preferred_auth_method = "apikey"',
    'model_reasoning_effort = "low"',
    'model_verbosity = "low"',
    'personality = "pragmatic"',
    'service_tier = "fast"',
    "",
    "[features]",
    "fast_mode = true",
    "runtime_metrics = true",
    "",
    "[model_providers.openrouter]",
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'env_key = "OPENROUTER_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    `[projects.${JSON.stringify(input.checkoutDir)}]`,
    'trust_level = "trusted"',
    ""
  ].join("\n");
}

async function writeOpenCodeConfig(opencodeHome: string, env: Pick<SandboxEnv, "openRouterApiKey" | "openRouterCodegenModel">) {
  const dataHome = path.join(opencodeHome, ".local", "share");
  const authDir = path.join(dataHome, "opencode");
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(
    path.join(authDir, "auth.json"),
    JSON.stringify(
      {
        openrouter: {
          type: "api",
          key: env.openRouterApiKey
        }
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  await fs.writeFile(path.join(opencodeHome, "opencode.json"), openCodeConfigJson({ model: env.openRouterCodegenModel }), {
    encoding: "utf8",
    mode: 0o600
  });
}

export function openCodeConfigJson(input: { model: string }) {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: openCodeModelId(input.model)
    },
    null,
    2
  );
}

function openCodeEnv(env: SandboxEnv, baseEnv: NodeJS.ProcessEnv, opencodeHome: string, toolShimDir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    HOME: opencodeHome,
    XDG_CONFIG_HOME: path.join(opencodeHome, ".config"),
    XDG_DATA_HOME: path.join(opencodeHome, ".local", "share"),
    OPENCODE_CONFIG: path.join(opencodeHome, "opencode.json"),
    OPENROUTER_API_KEY: env.openRouterApiKey,
    PATH: `${toolShimDir}${path.delimiter}${baseEnv.PATH ?? process.env.PATH ?? ""}`,
    AGENT_TOOL_SHIM_DIR: toolShimDir
  };
}

export function openCodeModelId(model: string) {
  return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
}

export function openCodeServeArgs(port: number) {
  return ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
}

export function openCodeRunArgs(input: { serverUrl: string; checkoutDir: string; model: string; title: string; prompt: string }) {
  return [
    "run",
    "--attach",
    input.serverUrl,
    "--dir",
    input.checkoutDir,
    "--model",
    openCodeModelId(input.model),
    "--format",
    "json",
    "--auto",
    "--title",
    input.title,
    input.prompt
  ];
}

async function runOpenCodeWithRecovery(input: {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  opencodeHome: string;
  toolShimDir: string;
  contextPack: CodegenContextPack;
}): Promise<CodexRunSummary> {
  const attempts: CodexAttemptSummary[] = [];
  const totalAttempts = 1;
  const attempt = 1;
  const prompt = codeUpdatePrompt(input.env, input.contextPack);
  await recordArtifact(input.env, {
    kind: "prompt",
    name: "OpenCode prompt",
    content: prompt,
    contentType: "text/plain",
    metadata: { model: openCodeModelId(input.env.openRouterCodegenModel), attempt, command: "opencode-run", harness: "opencode-server" }
  });
  await progress(input.env, "opencode_attempt_1", "Starting OpenCode server attempt 1/1.", {
    attempt,
    totalAttempts,
    command: "opencode-run",
    model: openCodeModelId(input.env.openRouterCodegenModel),
    harness: "opencode-server"
  });
  const firstDiffDeadlineMs = codegenFirstDiffDeadlineMs(input.contextPack, attempt);
  await progress(input.env, "opencode_first_diff_deadline", `Waiting up to ${formatDuration(firstDiffDeadlineMs)} for the first code diff.`, {
    attempt,
    totalAttempts,
    command: "opencode-run",
    harness: "opencode-server",
    deadlineMs: firstDiffDeadlineMs,
    anchored: Boolean(input.contextPack.anchorTargetFiles?.length)
  });

  const result = await runOpenCodeServerAttempt({ ...input, attempt, totalAttempts, prompt, firstDiffDeadlineMs });
  const gitStatus = await gitStatusPorcelain(input.checkoutDir).catch(() => "");
  const producedDiff = Boolean(gitStatus.trim());
  const summary: CodexAttemptSummary = {
    attempt,
    command: "opencode-run",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    producedDiff,
    watchdogReason: result.watchdog?.reason,
    stdoutTail: tail(result.stdout, MAX_RECOVERY_TAIL),
    stderrTail: tail(result.stderr, MAX_RECOVERY_TAIL)
  };
  attempts.push(summary);
  await progress(
    input.env,
    producedDiff ? "opencode_attempt_1_diff" : "opencode_attempt_1_no_diff",
    producedDiff ? "OpenCode attempt 1 produced a code diff." : "OpenCode attempt 1 finished without a code diff.",
    {
      attempt,
      totalAttempts,
      command: "opencode-run",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      watchdogReason: result.watchdog?.reason,
      gitStatus: tail(gitStatus, MAX_ACTIVITY_COMMAND_OUTPUT)
    }
  );

  if (producedDiff) return { attempts };
  throw new CodegenNoDiffError(
    [
      "Agent task produced no diff after OpenCode attempt; no PR will be opened.",
      ...attempts.map(
        (attempt) =>
          `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}, watchdog=${attempt.watchdogReason ?? "none"}`
      )
    ].join("\n")
  );
}

async function runOpenCodeServerAttempt(input: {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  opencodeHome: string;
  toolShimDir: string;
  attempt: number;
  totalAttempts: number;
  prompt: string;
  firstDiffDeadlineMs: number;
}): Promise<CommandResult> {
  const opencodeBinary = process.env.OPENCODE_BIN || "opencode";
  const opencodeEnv = openCodeEnv(input.env, input.gitEnv, input.opencodeHome, input.toolShimDir);
  const server = await startOpenCodeServer({ env: input.env, binary: opencodeBinary, cwd: input.checkoutDir, opencodeEnv });
  try {
    await progress(input.env, "opencode_server_ready", "OpenCode server is ready.", {
      attempt: input.attempt,
      serverUrl: server.serverUrl
    });
    return await runCommand(opencodeBinary, openCodeRunArgs({
      serverUrl: server.serverUrl,
      checkoutDir: input.checkoutDir,
      model: input.env.openRouterCodegenModel,
      title: input.env.taskTitle,
      prompt: input.prompt
    }), {
      cwd: input.checkoutDir,
      env: opencodeEnv,
      allowFailure: true,
      taskEnv: input.env,
      step: `opencode_attempt_${input.attempt}`,
      displayCommand: `${opencodeBinary} run --attach ${server.serverUrl} --dir ${input.checkoutDir} --model ${openCodeModelId(input.env.openRouterCodegenModel)} --format json --auto --title ${JSON.stringify(input.env.taskTitle)} [prompt]`,
      codexWatchdog: {
        checkoutDir: input.checkoutDir,
        attempt: input.attempt,
        totalAttempts: input.totalAttempts,
        firstDiffDeadlineMs: input.firstDiffDeadlineMs,
        firstDiffStep: "opencode_first_diff",
        firstDiffMessage: "OpenCode produced its first visible code diff.",
        watchdogStepPrefix: "opencode_watchdog",
        idleWithoutDiffMs: CODEX_IDLE_WITHOUT_DIFF_MS,
        reconnectStallMs: CODEX_RECONNECT_STALL_MS,
        maxRuntimeMs: CODEX_MAX_RUNTIME_MS,
        pollMs: CODEX_WATCHDOG_POLL_MS
      }
    });
  } finally {
    await stopOpenCodeServer(input.env, server).catch((error) => {
      console.error("Failed to stop OpenCode server cleanly", error);
    });
  }
}

async function startOpenCodeServer(input: {
  env: SandboxEnv;
  binary: string;
  cwd: string;
  opencodeEnv: NodeJS.ProcessEnv;
}): Promise<OpenCodeServerState> {
  const port = await reserveLocalPort();
  const args = openCodeServeArgs(port);
  const serverUrl = `http://127.0.0.1:${port}`;
  const commandLine = `${input.binary} ${args.join(" ")}`;
  const startedAt = Date.now();
  const child = spawn(input.binary, args, {
    cwd: input.cwd,
    env: input.opencodeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const state: OpenCodeServerState = {
    child,
    serverUrl,
    commandLine,
    startedAt,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    state.stdout += text;
    process.stdout.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    state.stderr += text;
    process.stderr.write(text);
  });
  child.once("error", (error) => {
    state.error = conciseError(error);
  });
  child.once("exit", (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
  });

  await progress(input.env, "opencode_server_start", "Starting OpenCode server.", {
    command: commandLine,
    serverUrl
  });
  try {
    await waitForOpenCodeServer(state);
    return state;
  } catch (error) {
    state.error = conciseError(error);
    await stopOpenCodeServer(input.env, state).catch(() => undefined);
    throw error;
  }
}

async function waitForOpenCodeServer(state: OpenCodeServerState, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (state.error) throw new Error(`OpenCode server failed to start: ${state.error}`);
    if (state.exitCode != null || state.signal != null) {
      throw new Error(`OpenCode server exited before it was ready: code=${state.exitCode ?? "null"} signal=${state.signal ?? "null"}`);
    }
    try {
      const response = await fetch(`${state.serverUrl}/global/health`);
      if (response.ok) return;
      lastError = `${response.status}: ${await response.text()}`;
    } catch (error) {
      lastError = conciseError(error);
    }
    await sleep(250);
  }
  throw new Error(`OpenCode server did not become healthy within ${formatDuration(timeoutMs)}${lastError ? `: ${lastError}` : ""}`);
}

async function stopOpenCodeServer(env: SandboxEnv, state: OpenCodeServerState) {
  if (state.exitCode == null && state.signal == null) {
    state.child.kill("SIGTERM");
    await waitForChildExit(state.child, 5_000).catch(() => {
      if (state.exitCode == null && state.signal == null) state.child.kill("SIGKILL");
    });
  }
  const durationMs = Date.now() - state.startedAt;
  const exitCode = state.error ? 1 : 0;
  await recordCommand(env, {
    step: "opencode_server",
    command: state.commandLine,
    exitCode,
    outputTail: tail(state.stdout, MAX_CAPTURED_COMMAND_OUTPUT),
    errorTail: tail([state.error, state.stderr].filter(Boolean).join("\n"), MAX_CAPTURED_COMMAND_OUTPUT),
    durationMs,
    metadata: {
      harness: "opencode-server",
      serverUrl: state.serverUrl,
      processExitCode: state.exitCode,
      signal: state.signal
    }
  });
  await recordArtifact(env, {
    kind: "command_log",
    name: "OpenCode server log",
    content: [
      `$ ${state.commandLine}`,
      state.stdout.trimEnd(),
      state.stderr.trimEnd(),
      state.error ? `error:\n${state.error}` : "",
      `[stopped after ${formatDuration(durationMs)}]`
    ]
      .filter(Boolean)
      .join("\n"),
    contentType: "text/plain",
    metadata: {
      step: "opencode_server",
      harness: "opencode-server",
      serverUrl: state.serverUrl,
      processExitCode: state.exitCode,
      signal: state.signal
    }
  });
}

async function runCodexWithRecovery(input: {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  workRoot: string;
  codexHome: string;
  toolShimDir: string;
  contextPack: CodegenContextPack;
}): Promise<CodexRunSummary> {
  try {
    return await runCodexAppServerWithRecovery(input);
  } catch (error) {
    if (error instanceof CodegenNoDiffError) {
      throw error;
    }
    const gitStatus = await gitStatusPorcelain(input.checkoutDir).catch(() => "");
    if (gitStatus.trim()) {
      await progress(input.env, "codex_app_server_salvaged_diff", "Codex app-server failed after producing a code diff; continuing to verification.", {
        error: conciseError(error),
        gitStatus: tail(gitStatus, MAX_ACTIVITY_COMMAND_OUTPUT)
      });
      return {
        attempts: [
          {
            attempt: 1,
            command: "app-server",
            exitCode: 1,
            durationMs: 0,
            producedDiff: true,
            stderrTail: conciseError(error),
            stdoutTail: tail(gitStatus, MAX_RECOVERY_TAIL)
          }
        ]
      };
    }
    await progress(input.env, "codex_app_server_fallback", "Codex app-server could not start a usable turn; falling back to codex exec.", {
      error: conciseError(error)
    });
    return runCodexExecWithRecovery(input);
  }
}

async function runCodexAppServerWithRecovery(input: {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  workRoot: string;
  codexHome: string;
  toolShimDir: string;
  contextPack: CodegenContextPack;
}): Promise<CodexRunSummary> {
  const attempts: CodexAttemptSummary[] = [];
  const totalAttempts = CODEX_APP_SERVER_MAX_ATTEMPTS;
  let threadId: string | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? codeUpdatePrompt(input.env, input.contextPack)
        : codeUpdateRecoveryPrompt(input.env, {
            attempt,
            totalAttempts,
            attempts,
            gitStatus: await gitStatusPorcelain(input.checkoutDir).catch((error) => `Unable to read git status: ${conciseError(error)}`),
            contextPack: input.contextPack
          });
    await recordArtifact(input.env, {
      kind: "prompt",
      name: attempt === 1 ? "Codex app-server prompt" : `Codex app-server recovery prompt ${attempt}`,
      content: prompt,
      contentType: "text/plain",
      metadata: { model: input.env.openRouterCodegenModel, attempt, command: "app-server", harness: "codex-app-server", threadId }
    });
    await progress(input.env, `codex_app_server_attempt_${attempt}`, `Starting Codex app-server attempt ${attempt}/${totalAttempts}.`, {
      attempt,
      totalAttempts,
      model: input.env.openRouterCodegenModel,
      harness: "codex-app-server",
      threadId
    });
    const firstDiffDeadlineMs = codegenFirstDiffDeadlineMs(input.contextPack, attempt);
    await progress(input.env, "codex_first_diff_deadline", `Waiting up to ${formatDuration(firstDiffDeadlineMs)} for the first code diff.`, {
      attempt,
      totalAttempts,
      harness: "codex-app-server",
      deadlineMs: firstDiffDeadlineMs,
      anchored: Boolean(input.contextPack.anchorTargetFiles?.length)
    });

    const result = await runCodexAppServerAttempt({
      ...input,
      attempt,
      totalAttempts,
      prompt,
      threadId
    });
    threadId = result.threadId ?? threadId;
    const gitStatus = await gitStatusPorcelain(input.checkoutDir).catch(() => "");
    const producedDiff = Boolean(gitStatus.trim());
    const summary: CodexAttemptSummary = {
      attempt,
      command: "app-server",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      producedDiff,
      watchdogReason: result.watchdog?.reason,
      stdoutTail: tail(result.transcript, MAX_RECOVERY_TAIL),
      stderrTail: tail([result.error, result.stderrTail].filter(Boolean).join("\n"), MAX_RECOVERY_TAIL)
    };
    attempts.push(summary);
    await progress(
      input.env,
      producedDiff ? `codex_app_server_attempt_${attempt}_diff` : `codex_app_server_attempt_${attempt}_no_diff`,
      producedDiff
        ? `Codex app-server attempt ${attempt} produced a code diff.`
        : `Codex app-server attempt ${attempt} finished without a code diff${attempt < totalAttempts ? "; retrying with a direct nudge." : "."}`,
      {
        attempt,
        totalAttempts,
        exitCode: result.exitCode,
        terminalMethod: result.terminalMethod,
        durationMs: result.durationMs,
        watchdogReason: result.watchdog?.reason,
        notificationCount: result.notifications.length,
        threadId,
        gitStatus: tail(gitStatus, MAX_ACTIVITY_COMMAND_OUTPUT)
      }
    );

    if (producedDiff) return { attempts };
    if (!result.startedTurn && result.exitCode !== 143) {
      throw new CodexAppServerStartupError(
        [
          "Codex app-server failed before starting a usable model turn.",
          ...attempts.map(
            (attempt) =>
              `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}, watchdog=${attempt.watchdogReason ?? "none"}`
          )
        ].join("\n")
      );
    }
    if (attempt < totalAttempts) continue;
  }

  throw new CodegenNoDiffError(
    [
      "Agent task produced no diff after Codex app-server recovery attempts; no PR will be opened.",
      ...attempts.map(
        (attempt) =>
          `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}, watchdog=${attempt.watchdogReason ?? "none"}`
      )
    ].join("\n")
  );
}

async function runCodexAppServerAttempt(input: {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  workRoot: string;
  codexHome: string;
  toolShimDir: string;
  contextPack: CodegenContextPack;
  attempt: number;
  totalAttempts: number;
  prompt: string;
  threadId?: string;
}): Promise<CodexAppServerAttemptResult> {
  const codexBinary = process.env.CODEX_BIN || "codex";
  const commandLine = `${codexBinary} app-server --listen stdio://`;
  const startedAt = Date.now();
  const notifications: CodexAppServerNotification[] = [];
  const transcriptLines: string[] = [];
  let lastNotificationAt = startedAt;
  let threadId = input.threadId;
  let terminalMethod: string | undefined;
  let exitCode = 0;
  let errorText = "";
  let reportedNotifications = 0;
  let startedTurn = false;
  const client = CodexAppServerClient.spawn({
    command: codexBinary,
    args: ["app-server", "--listen", "stdio://"],
    cwd: input.checkoutDir,
    env: codexEnv(input.env, input.gitEnv, input.codexHome, input.toolShimDir),
    model: input.env.openRouterCodegenModel,
    provider: providerForModel(input.env.openRouterCodegenModel),
    reasoningEffort: "low"
  });
  const watchdog = startCodexAppServerWatchdog({
    env: input.env,
    startedAt,
    command: commandLine,
    checkoutDir: input.checkoutDir,
    attempt: input.attempt,
    totalAttempts: input.totalAttempts,
    firstDiffDeadlineMs: codegenFirstDiffDeadlineMs(input.contextPack, input.attempt),
    idleWithoutDiffMs: CODEX_IDLE_WITHOUT_DIFF_MS,
    maxRuntimeMs: CODEX_MAX_RUNTIME_MS,
    pollMs: CODEX_WATCHDOG_POLL_MS,
    activityState: () => ({
      lastNotificationAt,
      notificationCount: notifications.length,
      transcriptTail: tail(transcriptLines.join("\n"), MAX_ACTIVITY_COMMAND_OUTPUT)
    }),
    close: () => client.close()
  });

  try {
    await client.initialize();
    threadId = threadId
      ? await client.resumeThread({ threadId, cwd: input.checkoutDir, provider: providerForModel(input.env.openRouterCodegenModel) })
      : await client.startThread({ cwd: input.checkoutDir, provider: providerForModel(input.env.openRouterCodegenModel) });
    await progress(input.env, "codex_app_server_thread", "Codex app-server thread is ready.", {
      threadId,
      attempt: input.attempt,
      resumed: Boolean(input.threadId)
    });
    const turn = await client.runTurn({
      threadId,
      text: input.prompt,
      model: input.env.openRouterCodegenModel,
      reasoningEffort: "low",
      onNotification: async (notification) => {
        notifications.push(notification);
        lastNotificationAt = Date.now();
        if (notification.method === "turn/started") startedTurn = true;
        const summary = codexNotificationSummary(notification);
        transcriptLines.push(formatCodexNotificationTranscriptLine(notification, summary));
        if (summary.report && reportedNotifications < 30) {
          reportedNotifications += 1;
          await progress(input.env, `codex_app_server_${sanitizeStepName(notification.method)}`, summary.message, {
            attempt: input.attempt,
            threadId,
            method: notification.method,
            ...summary.metadata
          }).catch(() => undefined);
        }
      }
    });
    terminalMethod = turn.terminalMethod;
    exitCode = terminalMethod === "turn/completed" ? 0 : 1;
  } catch (error) {
    errorText = conciseError(error);
    exitCode = watchdog.result().killed ? 143 : 1;
  } finally {
    watchdog.stop();
    await client.close().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  const transcript = transcriptLines.join("\n");
  const stderrTail = client.stderrTail();
  await recordCommand(input.env, {
    step: `codex_app_server_attempt_${input.attempt}`,
    command: commandLine,
    exitCode,
    outputTail: tail(transcript, MAX_CAPTURED_COMMAND_OUTPUT),
    errorTail: tail([errorText, stderrTail].filter(Boolean).join("\n"), MAX_CAPTURED_COMMAND_OUTPUT),
    durationMs,
    metadata: {
      harness: "codex-app-server",
      threadId,
      terminalMethod,
      notificationCount: notifications.length,
      watchdog: watchdog.result()
    }
  });
  await recordArtifact(input.env, {
    kind: "command_log",
    name: `Codex app-server attempt ${input.attempt} transcript`,
    content: [
      `$ ${commandLine}`,
      transcript,
      stderrTail ? `stderr:\n${stderrTail}` : "",
      errorText ? `error:\n${errorText}` : "",
      `[exit ${exitCode} in ${formatDuration(durationMs)}]`
    ]
      .filter(Boolean)
      .join("\n"),
    contentType: "application/jsonl",
    metadata: {
      harness: "codex-app-server",
      threadId,
      terminalMethod,
      notificationCount: notifications.length,
      watchdog: watchdog.result()
    }
  });

  return {
    exitCode,
    threadId,
    terminalMethod,
    durationMs,
    notifications,
    transcript,
    stderrTail,
    error: errorText || undefined,
    startedTurn,
    watchdog: watchdog.result()
  };
}

async function runCodexExecWithRecovery(input: {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  workRoot: string;
  codexHome: string;
  toolShimDir: string;
  contextPack: CodegenContextPack;
}): Promise<CodexRunSummary> {
  const attempts: CodexAttemptSummary[] = [];
  const codexBinary = process.env.CODEX_BIN || "codex";
  const totalAttempts = CODEX_EXEC_FALLBACK_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const command: CodexAttemptSummary["command"] = attempt === 1 ? "exec" : "resume";
    const prompt =
      attempt === 1
        ? codeUpdatePrompt(input.env, input.contextPack)
        : codeUpdateRecoveryPrompt(input.env, {
            attempt,
            totalAttempts,
            attempts,
            gitStatus: await gitStatusPorcelain(input.checkoutDir).catch((error) => `Unable to read git status: ${conciseError(error)}`),
            contextPack: input.contextPack
          });
    await recordArtifact(input.env, {
      kind: "prompt",
      name: attempt === 1 ? "Codex prompt" : `Codex recovery prompt ${attempt}`,
      content: prompt,
      contentType: "text/plain",
      metadata: { model: input.env.openRouterCodegenModel, attempt, command, harness: "codex-exec-json" }
    });
    await progress(input.env, `codex_attempt_${attempt}`, `Starting Codex ${command} attempt ${attempt}/${totalAttempts}.`, {
      attempt,
      totalAttempts,
      command,
      model: input.env.openRouterCodegenModel,
      harness: "codex-exec-json"
    });
    const firstDiffDeadlineMs = codegenFirstDiffDeadlineMs(input.contextPack, attempt);
    await progress(input.env, "codex_first_diff_deadline", `Waiting up to ${formatDuration(firstDiffDeadlineMs)} for the first code diff.`, {
      attempt,
      totalAttempts,
      command,
      harness: "codex-exec-json",
      deadlineMs: firstDiffDeadlineMs,
      anchored: Boolean(input.contextPack.anchorTargetFiles?.length)
    });

    const result = await runCommand(codexBinary, codexAttemptArgs({ command, model: input.env.openRouterCodegenModel }), {
      cwd: input.checkoutDir,
      env: codexEnv(input.env, input.gitEnv, input.codexHome, input.toolShimDir),
      input: prompt,
      allowFailure: true,
      taskEnv: input.env,
      step: `codex_attempt_${attempt}`,
      codexWatchdog: {
        checkoutDir: input.checkoutDir,
        attempt,
        totalAttempts,
        firstDiffDeadlineMs,
        idleWithoutDiffMs: CODEX_IDLE_WITHOUT_DIFF_MS,
        reconnectStallMs: CODEX_RECONNECT_STALL_MS,
        maxRuntimeMs: CODEX_MAX_RUNTIME_MS,
        pollMs: CODEX_WATCHDOG_POLL_MS
      }
    });
    const gitStatus = await gitStatusPorcelain(input.checkoutDir).catch(() => "");
    const producedDiff = Boolean(gitStatus.trim());
    const summary: CodexAttemptSummary = {
      attempt,
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      producedDiff,
      watchdogReason: result.watchdog?.reason,
      stdoutTail: tail(result.stdout, MAX_RECOVERY_TAIL),
      stderrTail: tail(result.stderr, MAX_RECOVERY_TAIL)
    };
    attempts.push(summary);
    await progress(
      input.env,
      producedDiff ? `codex_attempt_${attempt}_diff` : `codex_attempt_${attempt}_no_diff`,
      producedDiff
        ? `Codex attempt ${attempt} produced a code diff.`
        : `Codex attempt ${attempt} finished without a code diff${attempt < totalAttempts ? "; retrying with a direct nudge." : "."}`,
      {
        attempt,
        totalAttempts,
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        watchdogReason: result.watchdog?.reason,
        gitStatus: tail(gitStatus, MAX_ACTIVITY_COMMAND_OUTPUT)
      }
    );

    if (producedDiff) return { attempts };
    if (attempt < totalAttempts) continue;
  }

  throw new Error(
    [
      "Agent task produced no diff after Codex recovery attempts; no PR will be opened.",
      ...attempts.map(
        (attempt) =>
          `attempt ${attempt.attempt}: exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}, watchdog=${attempt.watchdogReason ?? "none"}`
      )
    ].join("\n")
  );
}

type CodegenContextRule = Required<
  Pick<CodegenContextPack, "focus" | "rationale" | "likelyMechanisms" | "suggestedFiles" | "firstInvariant" | "suggestedFirstEdit" | "avoid">
>;

const CODEGEN_CONTEXT_RULES: CodegenContextRule[] = [
  {
    focus: "agent_task_status_lifecycle",
    rationale:
      "The request mentions code updates, coding agents, progress, loading, completion, PRs, or sandbox behavior, so start with the durable agent task lifecycle.",
    likelyMechanisms: [
      "A Discord request first creates a temporary/status reply that is edited while work progresses.",
      "Code-update tool calls enqueue an agent task with a Discord response channel/message target.",
      "The task notifier renders queued/running/terminal state back into the original Discord message.",
      "Terminal task rendering must win over stale progress, late callbacks, and notification failures."
    ],
    suggestedFiles: [
      { path: "src/tools/coreTools.ts", reason: "Enqueues code-update tasks and creates the initial user-visible status." },
      { path: "src/discord/taskNotifications.ts", reason: "Renders task progress and terminal PR/failure states back to Discord." },
      { path: "src/db/repositories.ts", reason: "Persists task status, render signatures, and terminal task state." },
      { path: "src/jobs/queue.ts", reason: "Starts sandbox work and records task progress." },
      { path: "tests/unit/task-notifications.test.ts", reason: "Focused coverage for task message rendering." },
      { path: "tests/integration/repository-db.test.ts", reason: "Database coverage for terminal state and late progress behavior." }
    ],
    firstInvariant:
      "A code-update request should transition the same Discord status message to a terminal PR/failure/no-change state without leaving stale loading/progress text after completion.",
    suggestedFirstEdit:
      "Add or update a focused task notification or repository test proving terminal code-update state replaces stale progress after earlier render/status problems.",
    avoid: ["Do not search only for the user's exact wording; map product terms like loading/progress/done to task state and Discord message rendering."]
  },
  {
    focus: "discord_interaction_lifecycle",
    rationale: "The request mentions Discord messages, replies, memory, timeouts, or conversation behavior.",
    likelyMechanisms: [
      "Discord messages enter through the client adapter, are persisted, and are routed through the model/tool loop.",
      "Conversation memory is per Discord channel/thread and final responses are stored back into the session."
    ],
    suggestedFiles: [
      { path: "src/discord/client.ts", reason: "Discord message handling and reply/edit behavior." },
      { path: "src/agent/router.ts", reason: "Agent runtime, model/tool loop, and final response synthesis." },
      { path: "src/discord/messagePersistence.ts", reason: "Message persistence and incremental sync behavior." },
      { path: "tests/unit/discord-client.test.ts", reason: "Discord adapter coverage." },
      { path: "tests/integration/agent.test.ts", reason: "End-to-end agent behavior coverage." }
    ],
    firstInvariant: "Encode the requested Discord-visible behavior as one observable message/reply/session invariant.",
    suggestedFirstEdit: "Start with the closest Discord adapter or agent integration test, then make the minimal implementation change.",
    avoid: ["Do not bypass permission filtering or conversation memory contracts."]
  },
  {
    focus: "model_tool_routing",
    rationale: "The request mentions tools, search, model behavior, prompts, schemas, stats, or routing.",
    likelyMechanisms: [
      "The model chooses from explicit tools registered in the tool registry.",
      "Tool quality should usually improve through descriptions, schemas, result formatting, and retrieval behavior rather than hidden request-specific branches."
    ],
    suggestedFiles: [
      { path: "src/tools/registry.ts", reason: "Tool descriptions and schemas visible to the model." },
      { path: "src/tools/coreTools.ts", reason: "Core Discord/search/status/codegen tool implementations." },
      { path: "src/agent/router.ts", reason: "Model/tool execution loop." },
      { path: "tests/unit/tool-registry.test.ts", reason: "Tool schema coverage." },
      { path: "tests/unit/core-tools.test.ts", reason: "Tool behavior coverage." }
    ],
    firstInvariant: "Make the model have a better general-purpose tool affordance for the request class without adding hidden semantic branching.",
    suggestedFirstEdit: "Improve the narrowest tool schema/result/test that would let the model choose and use the right capability.",
    avoid: ["Do not add regex-only request routing when a tool contract can be improved instead."]
  },
  {
    focus: "general_implementation",
    rationale: "No narrower lifecycle matched confidently, so start from the likely adapter/tool/runtime boundary and nearest tests.",
    likelyMechanisms: ["Most user-visible behavior enters through the Discord adapter, model router, tool registry, or core tool implementations."],
    suggestedFiles: [
      { path: "src/discord/client.ts", reason: "Discord-facing behavior and request lifecycle." },
      { path: "src/agent/router.ts", reason: "Model-led agent behavior and final response synthesis." },
      { path: "src/tools/coreTools.ts", reason: "Tool implementations." },
      { path: "tests/integration/agent.test.ts", reason: "End-to-end model/tool behavior tests." }
    ],
    firstInvariant: "Turn the requested behavior into one focused observable invariant, implement the smallest code path that satisfies it, then broaden only as needed.",
    suggestedFirstEdit: "Start by adding or updating the closest existing test around the likely entry point before broad repository exploration.",
    avoid: ["Do not start with broad repository-wide exploration when a likely entry point is available."]
  }
];

export async function buildCodegenContextPack(checkoutDir: string, taskRequest = ""): Promise<CodegenContextPack> {
  const repoGuidePath = (await pathExists(path.join(checkoutDir, "AGENTS.md"))) ? "AGENTS.md" : undefined;
  const requestAnchors = extractCodegenRequestAnchors(taskRequest);
  const anchorMatches = await findCodegenAnchorMatches(checkoutDir, requestAnchors);
  const anchorTargetFiles = anchorTargetFilesFromMatches(anchorMatches);
  const focusedRule = selectCodegenContextRule(taskRequest, anchorMatches);
  const projectMap = await existingProjectMap(checkoutDir, [
    {
      area: "Code-update task lifecycle",
      purpose: "Requests to update the bot become durable agent tasks, Kubernetes sandbox runs, Discord progress edits, and PRs.",
      files: [
        "src/tools/coreTools.ts",
        "src/jobs/queue.ts",
        "src/execution/backend.ts",
        "src/execution/sandboxRunner.ts",
        "src/discord/taskNotifications.ts",
        "src/db/repositories.ts"
      ],
      checks: ["tests/unit/sandbox-runner.test.ts", "tests/unit/task-notifications.test.ts", "tests/integration/repository-db.test.ts"]
    },
    {
      area: "Discord mention and reply lifecycle",
      purpose: "Incoming Discord messages are persisted, routed through the model/tool loop, and answered or updated in Discord.",
      files: ["src/discord/client.ts", "src/agent/router.ts", "src/discord/messagePersistence.ts", "src/db/repositories.ts"],
      checks: ["tests/unit/discord-client.test.ts", "tests/integration/agent.test.ts", "tests/unit/message-persistence.test.ts"]
    },
    {
      area: "Model-led tools",
      purpose: "Tools are explicit capabilities selected by the model; prefer improving schemas/results over hidden message-specific branching.",
      files: ["src/tools/registry.ts", "src/tools/coreTools.ts", "src/tools/types.ts", "src/agent/router.ts"],
      checks: ["tests/unit/tool-registry.test.ts", "tests/unit/core-tools.test.ts", "tests/integration/agent.test.ts"]
    },
    {
      area: "Observability console",
      purpose: "Runs, spans, events, artifacts, and the React console explain what happened and where latency went.",
      files: ["src/observability/runs.ts", "src/control/internalApi.ts", "src/control/console/App.tsx", "src/control/console/styles.css"],
      checks: ["tests/unit/observability.test.ts", "tests/unit/internal-api-runs.test.ts", "tests/unit/run-console-timeline.test.ts"]
    }
  ]);
  const focusedSuggestedFiles = await existingSuggestedFiles(checkoutDir, focusedRule.suggestedFiles);
  const firstMoveRules = [
    "Read AGENTS.md first when present.",
    ...(anchorTargetFiles.length
      ? [
          "Exact request anchors were found; inspect the top anchor target file first and make the first edit there before reading broad project-map files.",
          "Do not spend more than three targeted file reads before the first code diff when anchor targets exist."
        ]
      : []),
    "After identifying the relevant flow, make the smallest useful test or implementation edit before doing broad repo archaeology.",
    "If the request describes a bug, prefer a focused regression test plus the smallest fix.",
    "If the request describes behavior or UX, update the behavior directly and cover the important contract with tests.",
    "Stop when the requested behavior is implemented and the most relevant checks have run."
  ];

  return {
    repoGuidePath,
    ...focusedRule,
    requestAnchors,
    anchorMatches,
    anchorTargetFiles,
    suggestedFiles: mergeSuggestedFiles(anchorTargetFiles, focusedSuggestedFiles),
    sandboxContract: [
      "You are already inside an isolated Kubernetes sandbox with full filesystem/network access for this task.",
      "The checkout is a writable task branch. Edit files directly in the current repository.",
      "Do not create commits, push branches, open PRs, or mutate GitHub state; the sandbox runner handles that after verification.",
      "Use helper CLIs by absolute shim path when useful: $AGENT_TOOL_SHIM_DIR/agent-task-context, $AGENT_TOOL_SHIM_DIR/agent-cache-info, $AGENT_TOOL_SHIM_DIR/agent-progress <step> <message>.",
      "Use apply_patch for focused file edits when available; otherwise use the smallest reliable edit command.",
      "Prefer rg for search, then read only the files needed for the next concrete edit."
    ],
    firstMoveRules,
    projectMap
  };
}

function extractCodegenRequestAnchors(taskRequest: string) {
  const anchors: string[] = [];
  const seen = new Set<string>();

  const add = (value: string, options: { exact?: boolean } = {}) => {
    const cleaned = value.trim().replace(/\s+/g, " ");
    if (!isUsefulCodegenAnchor(cleaned, options)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push(cleaned);
  };

  for (const regex of [/"([^"\n]{3,120})"/g, /`([^`\n]{3,120})`/g, /(?:^|[^A-Za-z])'([^'\n]{3,120})'(?![A-Za-z])/g, /“([^”]{3,120})”/g, /‘([^’]{3,120})’/g]) {
    for (const match of taskRequest.matchAll(regex)) add(match[1] ?? "", { exact: true });
  }

  for (const match of taskRequest.matchAll(/\b(?:src|tests|scripts|docs|infra|k8s|migrations|skills|\.github)\/[A-Za-z0-9._/-]+\b/g)) {
    add(match[0], { exact: true });
  }

  for (const match of taskRequest.matchAll(/(?:^|\s)(\/[a-z][a-z0-9/_:-]{2,})\b/g)) {
    add(match[1] ?? "", { exact: true });
  }

  for (const match of taskRequest.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) {
    add(match[0]);
  }

  for (const match of taskRequest.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/g)) {
    add(match[0]);
  }

  for (const match of taskRequest.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
    add(match[0]);
  }

  return anchors.slice(0, MAX_CODEGEN_ANCHORS);
}

function isUsefulCodegenAnchor(value: string, options: { exact?: boolean }) {
  if (value.length < 3 || value.length > 120) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  if (options.exact) return true;
  const normalized = value.toLowerCase();
  const genericTerms = new Set([
    "agent",
    "agents",
    "bot",
    "bots",
    "code",
    "discord",
    "finish",
    "loading",
    "message",
    "messages",
    "progress",
    "reply",
    "request",
    "requests",
    "status",
    "thinking",
    "update",
    "updates"
  ]);
  return !genericTerms.has(normalized);
}

async function findCodegenAnchorMatches(checkoutDir: string, anchors: string[]): Promise<CodegenAnchorMatch[]> {
  const matches: CodegenAnchorMatch[] = [];
  for (const anchor of anchors) {
    const output = await rgFixedString(checkoutDir, anchor);
    const parsed = output
      .split("\n")
      .map((line) => parseRgMatchLine(line, anchor))
      .filter((match): match is CodegenAnchorMatch => Boolean(match))
      .filter((match) => !isLowValueAnchorMatch(match.file))
      .slice(0, MAX_ANCHOR_MATCHES_PER_ANCHOR);
    matches.push(...parsed);
    if (matches.length >= MAX_ANCHOR_MATCHES_TOTAL) break;
  }
  return matches.slice(0, MAX_ANCHOR_MATCHES_TOTAL);
}

async function rgFixedString(checkoutDir: string, anchor: string) {
  return new Promise<string>((resolve) => {
    execFile(
      "rg",
      [
        "--fixed-strings",
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!dist/**",
        "--glob",
        "!coverage/**",
        "--glob",
        "!*.map",
        "--glob",
        "!package-lock.json",
        "--",
        anchor,
        "."
      ],
      { cwd: checkoutDir, maxBuffer: 512_000 },
      async (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve(await nodeFixedStringSearch(checkoutDir, anchor));
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}

async function nodeFixedStringSearch(checkoutDir: string, anchor: string) {
  const lines: string[] = [];
  await scanAnchorDirectory(checkoutDir, checkoutDir, anchor, lines);
  return lines.join("\n");
}

async function scanAnchorDirectory(rootDir: string, currentDir: string, anchor: string, matches: string[]) {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = normalizeRgRelativePath(path.relative(rootDir, fullPath));
    if (!relativePath || isLowValueAnchorMatch(relativePath)) continue;

    if (entry.isDirectory()) {
      await scanAnchorDirectory(rootDir, fullPath, anchor, matches);
      continue;
    }
    if (!entry.isFile()) continue;

    await scanAnchorFile(rootDir, fullPath, anchor, matches);
  }
}

async function scanAnchorFile(rootDir: string, filePath: string, anchor: string, matches: string[]) {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return;
  }
  if (stat.size > MAX_ANCHOR_SCAN_FILE_BYTES) return;

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  if (!content.includes(anchor)) return;

  const relativePath = normalizeRgRelativePath(path.relative(rootDir, filePath));
  const contentLines = content.split(/\r?\n/);
  for (const [index, line] of contentLines.entries()) {
    if (line.includes(anchor)) matches.push(`${relativePath}:${index + 1}:${line}`);
  }
}

function parseRgMatchLine(line: string, anchor: string): CodegenAnchorMatch | null {
  const match = /^(.+?):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  const file = normalizeRgRelativePath(match[1] ?? "");
  const lineNumber = Number(match[2]);
  if (!file || !Number.isFinite(lineNumber)) return null;
  return {
    anchor,
    file,
    line: lineNumber,
    preview: (match[3] ?? "").trim().slice(0, 220)
  };
}

function normalizeRgRelativePath(file: string) {
  return file.replace(/^\.\//, "");
}

function isLowValueAnchorMatch(file: string) {
  return (
    file === ".git" ||
    file === "node_modules" ||
    file === "dist" ||
    file === "coverage" ||
    file.startsWith(".git/") ||
    file.startsWith("node_modules/") ||
    file.startsWith("dist/") ||
    file.startsWith("coverage/") ||
    file.endsWith(".map") ||
    file === "package-lock.json"
  );
}

function anchorTargetFilesFromMatches(matches: CodegenAnchorMatch[]) {
  const byFile = new Map<string, { anchors: Set<string>; lines: number[]; score: number }>();
  for (const match of matches) {
    const current = byFile.get(match.file) ?? { anchors: new Set<string>(), lines: [], score: sourceFileScore(match.file) };
    current.anchors.add(match.anchor);
    current.lines.push(match.line);
    current.score += anchorMatchScore(match);
    byFile.set(match.file, current);
  }

  return [...byFile.entries()]
    .sort(
      (left, right) =>
        anchorTargetFileRank(right[0]) - anchorTargetFileRank(left[0]) ||
        right[1].score - left[1].score ||
        left[0].localeCompare(right[0])
    )
    .slice(0, MAX_ANCHOR_TARGET_FILES)
    .map(([file, value]) => {
      const anchors = [...value.anchors].slice(0, 3).map((anchor) => JSON.stringify(anchor)).join(", ");
      const lines = uniqueNumbers(value.lines).slice(0, 4).join(", ");
      return {
        path: file,
        reason: `Exact request anchor${value.anchors.size === 1 ? "" : "s"} ${anchors} matched at line${value.lines.length === 1 ? "" : "s"} ${lines}.`
      };
    });
}

function sourceFileScore(file: string) {
  if (file.startsWith("src/")) return 6;
  if (file.startsWith("tests/")) return 4;
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return 3;
  if (file === "AGENTS.md" || file.endsWith(".md")) return 1;
  return 0;
}

function anchorTargetFileRank(file: string) {
  if (file.startsWith("src/")) return 4;
  if (file.startsWith("tests/")) return 2;
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return 3;
  if (file === "AGENTS.md" || file.endsWith(".md")) return 1;
  return 0;
}

function anchorMatchScore(match: CodegenAnchorMatch) {
  let score = 2;
  if (/[{};]|=>|\b(?:await|const|let|function|return|class|import|export)\b/.test(match.preview)) score += 3;
  if (match.preview.length <= 140) score += 1;
  if (/\b(?:description|schema|prompt|instructions?)\b/i.test(match.preview) && match.preview.length > 140) score -= 2;
  return score;
}

function mergeSuggestedFiles(
  anchorTargetFiles: Array<{ path: string; reason: string }>,
  suggestedFiles: Array<{ path: string; reason: string }>
) {
  const seen = new Set<string>();
  return [...anchorTargetFiles, ...suggestedFiles].filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function selectCodegenContextRule(taskRequest: string, anchorMatches: CodegenAnchorMatch[] = []): CodegenContextRule {
  const text = taskRequest.toLowerCase();
  const anchorFiles = new Set(anchorMatches.map((match) => match.file));
  const hasDiscordClientAnchor = [...anchorFiles].some((file) => file === "src/discord/client.ts" || file.startsWith("src/discord/"));
  const hasTaskLifecycleAnchor = [...anchorFiles].some((file) =>
    ["src/discord/taskNotifications.ts", "src/tools/coreTools.ts", "src/jobs/queue.ts", "src/db/repositories.ts"].includes(file)
  );
  if (hasDiscordClientAnchor && !hasTaskLifecycleAnchor && includesAny(text, ["thinking", "reply", "reaction", "message", "discord"])) {
    return CODEGEN_CONTEXT_RULES[1]!;
  }
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
  if (hasCodeUpdateTerm || (hasStatusTerm && includesAny(text, ["code", "agent", "bot", "request"]))) return CODEGEN_CONTEXT_RULES[0]!;
  if (includesAny(text, ["discord", "mention", "reply", "message", "timeout", "content filter", "conversation", "memory"])) {
    return CODEGEN_CONTEXT_RULES[1]!;
  }
  if (includesAny(text, ["tool", "search", "history", "web", "model", "prompt", "router", "schema", "stats"])) return CODEGEN_CONTEXT_RULES[2]!;
  return CODEGEN_CONTEXT_RULES[3]!;
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

async function existingSuggestedFiles(checkoutDir: string, files: CodegenContextRule["suggestedFiles"]) {
  const existing = await Promise.all(files.map(async (file) => ((await pathExists(path.join(checkoutDir, file.path))) ? file : null)));
  const filtered = existing.filter((file): file is CodegenContextRule["suggestedFiles"][number] => Boolean(file));
  return filtered.length ? filtered : files;
}

async function existingProjectMap(checkoutDir: string, entries: CodegenContextPack["projectMap"]) {
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      files: await existingRelativePaths(checkoutDir, entry.files),
      checks: await existingRelativePaths(checkoutDir, entry.checks)
    }))
  );
}

async function existingRelativePaths(checkoutDir: string, relativePaths: string[]) {
  const checks = await Promise.all(relativePaths.map(async (file) => ((await pathExists(path.join(checkoutDir, file))) ? file : null)));
  return checks.filter((file): file is string => Boolean(file));
}

export function renderCodegenContextPack(context: CodegenContextPack) {
  const lines = [
    ...(context.requestAnchors?.length || context.anchorTargetFiles?.length
      ? [
          "Concrete request anchors:",
          ...(context.requestAnchors?.length ? context.requestAnchors.map((anchor) => `- ${anchor}`) : ["- none found"]),
          "",
          ...(context.anchorTargetFiles?.length
            ? [
                "Target files from exact request evidence:",
                ...context.anchorTargetFiles.map((file) => `- ${file.path}: ${file.reason}`),
                "",
                "Anchor guidance:",
                "- Concrete request anchors outrank broad lifecycle guesses. Inspect these target files first and make the first focused edit there unless the code proves they are unrelated.",
                ""
              ]
            : []),
          ...(context.anchorMatches?.length
            ? [
                "Anchor match samples:",
                ...context.anchorMatches.slice(0, 12).map((match) => `- ${match.file}:${match.line} (${match.anchor}): ${match.preview}`),
                ""
              ]
            : [])
        ]
      : []),
    ...(context.focus
      ? [
          `Focus: ${context.focus}`,
          "",
          `Why this context: ${context.rationale ?? "Matched from the requested update."}`,
          "",
          "Likely mechanisms:",
          ...(context.likelyMechanisms ?? []).map((mechanism) => `- ${mechanism}`),
          "",
          "Suggested first files:",
          ...(context.suggestedFiles ?? []).map((file) => `- ${file.path}: ${file.reason}`),
          "",
          "First implementable invariant:",
          context.firstInvariant ?? "Make the requested behavior observable with the smallest focused change.",
          "",
          "Suggested first edit:",
          context.suggestedFirstEdit ?? "Add or update the closest focused test before broad exploration.",
          "",
          "Avoid:",
          ...(context.avoid ?? []).map((warning) => `- ${warning}`),
          ""
        ]
      : []),
    "Repository guide:",
    context.repoGuidePath ? `- ${context.repoGuidePath}` : "- none found",
    "",
    "Sandbox contract:",
    ...context.sandboxContract.map((item) => `- ${item}`),
    "",
    "First move rules:",
    ...context.firstMoveRules.map((item) => `- ${item}`),
    "",
    "Project map:"
  ];
  for (const entry of context.projectMap) {
    lines.push(`- ${entry.area}: ${entry.purpose}`);
    if (entry.files.length) lines.push(`  Files: ${entry.files.join(", ")}`);
    if (entry.checks.length) lines.push(`  Checks: ${entry.checks.join(", ")}`);
  }
  return tail(lines.join("\n"), MAX_CONTEXT_TEXT);
}

export function codeUpdatePrompt(env: Pick<SandboxEnv, "taskId" | "requestedBy" | "taskRequest">, contextPack?: CodegenContextPack) {
  const contextText = contextPack ? renderCodegenContextPack(contextPack) : "";
  return [
    "You are implementing a Discord-requested update to this TypeScript Discord AI Agent repository.",
    "",
    "Working style:",
    "- Move like a senior maintainer: understand just enough, make the smallest coherent change, then validate it.",
    "- Be decisive once the relevant files are identified.",
    "- Do not spend the whole run inspecting. Make a focused test or implementation edit early.",
    "- Do not ask follow-up questions. When the request has multiple plausible interpretations, choose the one that preserves existing workflows and makes the requested behavior true.",
    "- Prefer the existing architecture and tests over new abstractions.",
    "- If you are unsure between two nearby files, inspect both briefly, then edit.",
    "",
    "Requirements:",
    "- If AGENTS.md exists, read it before editing and follow it.",
    "- Read the relevant code before editing.",
    "- Implement the requested behavior with a real code diff.",
    "- Keep changes focused and consistent with the existing architecture.",
    "- Add or update tests for the changed behavior.",
    "- Do not commit, push, open a PR, or edit GitHub state yourself.",
    "- Do not add request-only documentation artifacts; the PR body records the request.",
    "- Before finishing, run the most relevant checks you can.",
    "- Helper CLIs are available under `$AGENT_TOOL_SHIM_DIR`; use `$AGENT_TOOL_SHIM_DIR/agent-task-context`, `$AGENT_TOOL_SHIM_DIR/agent-cache-info`, and `$AGENT_TOOL_SHIM_DIR/agent-progress <step> <message>` so login shells cannot hide them.",
    "",
    `Task ID: ${env.taskId}`,
    `Requested by: ${env.requestedBy}`,
    contextText ? "" : undefined,
    contextText ? "Codegen preflight context:" : undefined,
    contextText || undefined,
    contextText
      ? "Use the preflight context as a starting map, not as proof. If exact request anchor target files are present, inspect those before lifecycle files. Concrete anchors from the request outrank broad lifecycle guesses. Make the suggested first edit and first implementable invariant true."
      : undefined,
    "",
    "Patch-first budget:",
    "- Read AGENTS.md if present, then inspect only the smallest snippets needed to make the first edit.",
    "- When exact request anchor targets are present, read the top target file around the matched line and patch that owner before reading broad project-map files.",
    "- If no anchor targets exist, read the likely entry point, one helper/adapter, and one closest test, then edit.",
    "- Use `apply_patch` for the first focused edit when available. The first patch can be small and imperfect; refine it after tests or caller reads.",
    "- Do not inspect status plumbing, queue code, observability UI, or extra tests before the first edit unless one of those files is the top target or required by the code you are changing.",
    "- If you are unsure, make a small reversible implementation edit in the best target file and refine it after tests or callers reveal more.",
    "",
    "Implementation workflow:",
    "- First inspection pass: read the likely entry point, the closest existing helper/adapter, and the closest tests. Avoid broad repository archaeology before the first edit.",
    "- If the preflight found exact quoted text, paths, symbols, env vars, routes, or tool names from the request, treat those matches as the first inspection result and patch the owning file unless it is clearly unrelated.",
    "- User wording may describe product behavior instead of exact code symbols. If literal searches miss, map the phrase to the closest existing mechanism in the lifecycle, such as a Discord reply edit, status callback, reaction, queue state, or persisted run status.",
    "- If the request changes user-visible behavior, map the lifecycle before editing: trigger -> temporary state -> progress/update paths -> success response -> error/timeout/cancellation -> cleanup.",
    "- If the behavior spans more than one path, introduce or reuse a small abstraction that owns the lifecycle instead of patching each call site independently.",
    "- Preserve existing invariants that other code may depend on. If replacing a visible mechanism, keep any underlying state or callback contract intact unless the request explicitly says to remove it.",
    "- For bug fixes, encode the requested behavior as a focused invariant in code or tests early. Do not conclude that existing behavior is fine merely because the first matching path appears intentional.",
    "- Make a focused first edit after the likely lifecycle owner is identified, then run `$AGENT_TOOL_SHIM_DIR/agent-progress first_edit \"Made the first focused code edit\"`.",
    "- After the first edit, broaden the search only to cover callers, failure paths, and tests touched by that lifecycle.",
    "",
    "Stall avoidance:",
    "- Do not repeatedly reread the same file or expand into unrelated UI, observability, deployment, or queue code unless the lifecycle map shows it is required.",
    "- After a few targeted searches, stop searching for exact request vocabulary and act on the closest mechanism you found.",
    "- Do not leave the checkout clean after you understand the target. Create a diff, then inspect more only to refine it.",
    "- Produce a real code diff promptly; pure analysis without edits will be stopped and retried.",
    "",
    "Requested update:",
    env.taskRequest.trim(),
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function codexExecArgs(input: { checkoutDir: string; model: string }) {
  return [
    "exec",
    "--json",
    "-C",
    input.checkoutDir,
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    input.model,
    "-"
  ];
}

export function codexResumeExecArgs(input: { model: string }) {
  return ["exec", "resume", "--last", "--json", "--dangerously-bypass-approvals-and-sandbox", "-m", input.model, "-"];
}

function codexAttemptArgs(input: { command: "exec" | "resume"; model: string }) {
  return input.command === "exec" ? codexExecArgs({ checkoutDir: ".", model: input.model }) : codexResumeExecArgs({ model: input.model });
}

export function codegenFirstDiffDeadlineMs(contextPack?: Pick<CodegenContextPack, "anchorTargetFiles">, attempt = 1) {
  const anchored = Boolean(contextPack?.anchorTargetFiles?.length);
  if (attempt > 1) return anchored ? CODEX_ANCHORED_FIRST_DIFF_RECOVERY_DEADLINE_MS : CODEX_FIRST_DIFF_RECOVERY_DEADLINE_MS;
  return anchored ? CODEX_ANCHORED_FIRST_DIFF_DEADLINE_MS : CODEX_FIRST_DIFF_DEADLINE_MS;
}

export function codeUpdateRecoveryPrompt(
  env: SandboxEnv,
  input: { attempt: number; totalAttempts: number; attempts: CodexAttemptSummary[]; gitStatus: string; contextPack?: CodegenContextPack }
) {
  const previous = input.attempts.at(-1);
  const anchorTargetText = recoveryAnchorTargetText(input.contextPack);
  return [
    "Continue the same code-update task in this existing sandbox checkout.",
    "",
    "The previous Codex attempt did not leave a code diff. Do not restart broad analysis.",
    "You have enough context to act: make the smallest focused test or implementation edit now, then run the most relevant check.",
    "If you need one more file, inspect it briefly and edit immediately after. Do not run more than one read/search command before the first patch on this attempt.",
    "Use apply_patch for the recovery edit when available; otherwise use the smallest reliable edit command. A small first diff is better than more clean-checkout analysis.",
    anchorTargetText ? "Patch-first targets from the original request anchors:" : undefined,
    anchorTargetText || undefined,
    anchorTargetText
      ? "On this recovery attempt, edit one of these files before additional broad searching unless the file is clearly unrelated."
      : undefined,
    "",
    `Task ID: ${env.taskId}`,
    `Attempt: ${input.attempt}/${input.totalAttempts}`,
    "",
    "Requested update:",
    env.taskRequest.trim(),
    "",
    "Current git status:",
    input.gitStatus.trim() || "(clean)",
    "",
    previous
      ? [
          "Previous attempt summary:",
          `- exit code: ${previous.exitCode}`,
          `- duration: ${formatDuration(previous.durationMs)}`,
          `- watchdog: ${previous.watchdogReason ?? "none"}`,
          previous.stdoutTail ? `- stdout tail:\n${previous.stdoutTail}` : "",
          previous.stderrTail ? `- stderr tail:\n${previous.stderrTail}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
    "Finish with a real code diff. Do not commit, push, or open a PR yourself."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function recoveryAnchorTargetText(contextPack?: CodegenContextPack) {
  const targets = contextPack?.anchorTargetFiles ?? [];
  if (!targets.length) return "";
  return targets
    .slice(0, 5)
    .map((file) => `- ${file.path}: ${file.reason}`)
    .join("\n");
}

export function evaluateCodegenWatchdog(input: CodegenWatchdogInput): CodegenWatchdogDecision | null {
  const noFirstDiffTimeoutMs = input.noFirstDiffTimeoutMs ?? CODEX_FIRST_DIFF_DEADLINE_MS;
  const idleTimeoutMs = input.idleTimeoutMs ?? CODEX_IDLE_WITHOUT_DIFF_MS;
  const reconnectStallTimeoutMs = input.reconnectStallTimeoutMs ?? CODEX_RECONNECT_STALL_MS;
  const maxRuntimeMs = input.maxRuntimeMs ?? CODEX_MAX_RUNTIME_MS;

  if (!input.hasDiff && input.elapsedMs >= noFirstDiffTimeoutMs) {
    return {
      action: "fail",
      reason: "no_first_diff",
      message: `Coding harness produced no code diff after ${formatDuration(input.elapsedMs)}; stopping early so this can be retried with a narrower implementation pass.`
    };
  }

  if (input.reconnectSeen && input.reconnectStallMs != null && input.reconnectStallMs >= reconnectStallTimeoutMs) {
    return {
      action: input.hasDiff ? "continue" : "fail",
      reason: "reconnect_stall",
      message: input.hasDiff
        ? "Coding harness stalled after a reconnect but already produced a code diff; stopping it and continuing to verification."
        : "Coding harness stalled after a reconnect before producing a code diff; stopping early so this can be retried."
    };
  }

  if (input.idleMs >= idleTimeoutMs) {
    return {
      action: input.hasDiff ? "continue" : "fail",
      reason: input.hasDiff ? "idle_after_diff" : "idle_before_diff",
      message: input.hasDiff
        ? "Coding harness stopped producing output after creating a code diff; stopping it and continuing to verification."
        : "Coding harness stopped producing output before creating a code diff; stopping early so this can be retried."
    };
  }

  if (input.elapsedMs >= maxRuntimeMs) {
    return {
      action: input.hasDiff ? "continue" : "fail",
      reason: "max_runtime",
      message: input.hasDiff
        ? `Coding harness reached ${formatDuration(input.elapsedMs)} with a code diff; stopping it and continuing to verification.`
        : `Coding harness reached ${formatDuration(input.elapsedMs)} without a code diff; stopping before the Kubernetes deadline.`
    };
  }

  return null;
}

export function codeUpdatePullRequestBody(input: { env: Pick<SandboxEnv, "taskRequest" | "requestedBy">; verifyPassed: boolean }) {
  return [
    "## Why",
    "",
    input.env.taskRequest.trim(),
    "",
    "## Changes",
    "",
    "- Implemented by the Discord AI Agent sandbox.",
    "- See the PR diff for the exact code changes.",
    "",
    "## Testing",
    "",
    `- \`npm run verify\`: ${input.verifyPassed ? "passed" : "failed; opened as draft"}`,
    "- `npm run scan:release`: passed",
    "",
    "---",
    "",
    `Prompted by: ${input.env.requestedBy}`
  ].join("\n");
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    displayCommand?: string;
    allowFailure?: boolean;
    taskEnv?: SandboxEnv;
    step?: string;
    codexWatchdog?: CodexWatchdogOptions;
  }
): Promise<CommandResult> {
  console.log(JSON.stringify({ event: "sandbox.command.start", command: options.displayCommand ?? command, args: options.displayCommand ? ["[displayed command redacted]"] : redactedArgs(command, args), cwd: options.cwd }));
  const startedAt = Date.now();
  const step = options.step ?? command;
  let lastOutputAt = startedAt;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  const commandLine = options.displayCommand ?? `${command} ${redactedArgs(command, args).join(" ")}`.trim();
  const activityTimer =
    options.taskEnv && shouldEmitCommandActivity(step)
      ? setInterval(() => {
          void progress(options.taskEnv!, `${step}_activity`, `${step} is still running after ${formatDuration(Date.now() - startedAt)}.`, {
            command: commandLine,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            stdoutTail: tail(stdout, MAX_ACTIVITY_COMMAND_OUTPUT),
            stderrTail: tail(stderr, MAX_ACTIVITY_COMMAND_OUTPUT),
            durationMs: Date.now() - startedAt
          }).catch(() => undefined);
        }, 30_000)
      : undefined;
  activityTimer?.unref?.();
  const codexWatchdog = options.codexWatchdog
    ? startCodexWatchdog({
        env: options.taskEnv,
        child,
        startedAt,
        command: commandLine,
        outputState: () => ({
          stdout,
          stderr,
          lastOutputAt
        }),
        options: options.codexWatchdog
      })
    : undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    lastOutputAt = Date.now();
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    lastOutputAt = Date.now();
    process.stderr.write(text);
  });

  if (options.input) child.stdin.write(options.input);
  child.stdin.end();

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    if (activityTimer) clearInterval(activityTimer);
    codexWatchdog?.stop();
  }
  const duration = Date.now() - startedAt;
  await recordCommand(options.taskEnv, {
    step,
    command: commandLine,
    exitCode,
    outputTail: tail(stdout, MAX_CAPTURED_COMMAND_OUTPUT),
    errorTail: tail(stderr, MAX_CAPTURED_COMMAND_OUTPUT),
    durationMs: duration,
    metadata: codexWatchdog?.result()
  });
  await recordArtifact(options.taskEnv, {
    kind: "command_log",
    name: `${step} command log`,
    content: [`$ ${commandLine}`, stdout.trimEnd(), stderr.trimEnd(), `[exit ${exitCode} in ${formatDuration(duration)}]`]
      .filter(Boolean)
      .join("\n"),
    contentType: "text/plain",
    metadata: { step, command: commandLine, exitCode, watchdog: codexWatchdog?.result() }
  });
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}: ${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr, durationMs: duration, watchdog: codexWatchdog?.result() };
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
    metadata?: Record<string, unknown>;
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

function startCodexWatchdog(input: {
  env?: SandboxEnv;
  child: ReturnType<typeof spawn>;
  startedAt: number;
  command: string;
  outputState: () => { stdout: string; stderr: string; lastOutputAt: number };
  options: CodexWatchdogOptions;
}) {
  let stopped = false;
  let checking = false;
  let killTimer: NodeJS.Timeout | undefined;
  const result: CodexWatchdogResult = { killed: false };
  const pollMs = input.options.pollMs ?? CODEX_WATCHDOG_POLL_MS;
  let lastStdoutChars = 0;
  let lastStderrChars = 0;
  let reconnectSeenAt: number | null = null;
  let reconnectOutputChangedAt: number | null = null;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (killTimer) clearTimeout(killTimer);
  };

  const kill = async (reason: string, message: string, metadata: Record<string, unknown>) => {
    if (result.killed || stopped) return;
    result.killed = true;
    result.reason = reason;
    result.durationMs = Date.now() - input.startedAt;
    result.lastOutputAtMs = Math.max(0, input.outputState().lastOutputAt - input.startedAt);
    await progress(input.env!, `${input.options.watchdogStepPrefix ?? "codex_watchdog"}_${reason}`, message, {
      ...metadata,
      attempt: input.options.attempt,
      totalAttempts: input.options.totalAttempts,
      command: input.command,
      durationMs: result.durationMs,
      lastOutputAtMs: result.lastOutputAtMs
    }).catch(() => undefined);
    input.child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (input.child.exitCode === null && input.child.signalCode === null) input.child.kill("SIGKILL");
    }, 5_000);
    killTimer.unref?.();
  };

  const timer = setInterval(() => {
    if (!input.env || checking || stopped || result.killed) return;
    const env = input.env;
    checking = true;
    void (async () => {
      try {
        const durationMs = Date.now() - input.startedAt;
        const outputState = input.outputState();
        const outputChanged = outputState.stdout.length !== lastStdoutChars || outputState.stderr.length !== lastStderrChars;
        if (outputChanged) {
          lastStdoutChars = outputState.stdout.length;
          lastStderrChars = outputState.stderr.length;
        }
        if (CODEX_RECONNECT_PATTERN.test(outputState.stdout) || CODEX_RECONNECT_PATTERN.test(outputState.stderr)) {
          reconnectSeenAt ??= Date.now();
          if (outputChanged) reconnectOutputChangedAt = Date.now();
        }
        const status = await gitStatusPorcelain(input.options.checkoutDir).catch(() => "");
        const producedDiff = Boolean(status.trim());
        if (producedDiff && result.firstDiffSeenAtMs == null) {
          result.firstDiffSeenAtMs = durationMs;
          await progress(env, input.options.firstDiffStep ?? "codex_first_diff", input.options.firstDiffMessage ?? "Codex produced its first visible code diff.", {
            attempt: input.options.attempt,
            durationMs,
            gitStatus: tail(status, MAX_ACTIVITY_COMMAND_OUTPUT)
          }).catch(() => undefined);
        }

        const idleMs = Date.now() - outputState.lastOutputAt;
        const reconnectStallMs = reconnectSeenAt == null ? null : Date.now() - (reconnectOutputChangedAt ?? reconnectSeenAt);
        const decision = evaluateCodegenWatchdog({
          elapsedMs: durationMs,
          idleMs,
          hasDiff: producedDiff,
          reconnectSeen: reconnectSeenAt != null,
          reconnectStallMs,
          noFirstDiffTimeoutMs: input.options.firstDiffDeadlineMs,
          idleTimeoutMs: input.options.idleWithoutDiffMs,
          reconnectStallTimeoutMs: input.options.reconnectStallMs,
          maxRuntimeMs: input.options.maxRuntimeMs
        });
        if (decision) {
          await kill(decision.reason, decision.message, {
            idleMs,
            action: decision.action,
            reconnectSeen: reconnectSeenAt != null,
            reconnectStallMs,
            stdoutChars: outputState.stdout.length,
            stderrChars: outputState.stderr.length,
            stdoutTail: tail(outputState.stdout, MAX_ACTIVITY_COMMAND_OUTPUT),
            stderrTail: tail(outputState.stderr, MAX_ACTIVITY_COMMAND_OUTPUT),
            hasDiff: producedDiff,
            gitStatus: tail(status, MAX_ACTIVITY_COMMAND_OUTPUT)
          });
        }
      } finally {
        checking = false;
      }
    })();
  }, pollMs);
  timer.unref?.();

  return {
    stop,
    result: () => result
  };
}

function startCodexAppServerWatchdog(input: {
  env: SandboxEnv;
  startedAt: number;
  command: string;
  checkoutDir: string;
  attempt: number;
  totalAttempts: number;
  firstDiffDeadlineMs?: number;
  idleWithoutDiffMs?: number;
  maxRuntimeMs?: number;
  pollMs?: number;
  activityState: () => { lastNotificationAt: number; notificationCount: number; transcriptTail: string };
  close: () => Promise<void>;
}) {
  let stopped = false;
  let checking = false;
  const result: CodexWatchdogResult = { killed: false };
  const pollMs = input.pollMs ?? CODEX_WATCHDOG_POLL_MS;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };

  const close = async (reason: string, message: string, metadata: Record<string, unknown>) => {
    if (result.killed || stopped) return;
    const activity = input.activityState();
    result.killed = true;
    result.reason = reason;
    result.durationMs = Date.now() - input.startedAt;
    result.lastOutputAtMs = Math.max(0, activity.lastNotificationAt - input.startedAt);
    await progress(input.env, `codex_app_server_watchdog_${reason}`, message, {
      ...metadata,
      attempt: input.attempt,
      totalAttempts: input.totalAttempts,
      command: input.command,
      durationMs: result.durationMs,
      lastOutputAtMs: result.lastOutputAtMs
    }).catch(() => undefined);
    await input.close().catch(() => undefined);
  };

  const timer = setInterval(() => {
    if (checking || stopped || result.killed) return;
    checking = true;
    void (async () => {
      try {
        const durationMs = Date.now() - input.startedAt;
        const activity = input.activityState();
        const status = await gitStatusPorcelain(input.checkoutDir).catch(() => "");
        const producedDiff = Boolean(status.trim());
        if (producedDiff && result.firstDiffSeenAtMs == null) {
          result.firstDiffSeenAtMs = durationMs;
          await progress(input.env, "codex_app_server_first_diff", "Codex app-server produced its first visible code diff.", {
            attempt: input.attempt,
            durationMs,
            gitStatus: tail(status, MAX_ACTIVITY_COMMAND_OUTPUT)
          }).catch(() => undefined);
        }
        const idleMs = Date.now() - activity.lastNotificationAt;
        const decision = evaluateCodegenWatchdog({
          elapsedMs: durationMs,
          idleMs,
          hasDiff: producedDiff,
          reconnectSeen: false,
          reconnectStallMs: null,
          noFirstDiffTimeoutMs: input.firstDiffDeadlineMs,
          idleTimeoutMs: input.idleWithoutDiffMs,
          maxRuntimeMs: input.maxRuntimeMs
        });
        if (decision) {
          await close(decision.reason, decision.message, {
            idleMs,
            action: decision.action,
            notificationCount: activity.notificationCount,
            transcriptTail: activity.transcriptTail,
            hasDiff: producedDiff,
            gitStatus: tail(status, MAX_ACTIVITY_COMMAND_OUTPUT)
          });
        }
      } finally {
        checking = false;
      }
    })();
  }, pollMs);
  timer.unref?.();

  return {
    stop,
    result: () => result
  };
}

function codexNotificationSummary(notification: CodexAppServerNotification): {
  message: string;
  report: boolean;
  metadata: Record<string, unknown>;
} {
  const method = notification.method;
  const itemType = jsonStringAt(notification.raw, ["params", "item", "type"]) ?? jsonStringAt(notification.raw, ["params", "type"]);
  const itemId = jsonStringAt(notification.raw, ["params", "item", "id"]) ?? jsonStringAt(notification.raw, ["params", "itemId"]);
  const command = jsonStringAt(notification.raw, ["params", "command"]) ?? jsonStringAt(notification.raw, ["params", "cmd"]);
  const metadata: Record<string, unknown> = {
    itemType,
    itemId,
    command,
    paramsPreview: compactJson(notification.params)
  };
  if (method === "turn/started") return { message: "Codex turn started.", report: true, metadata };
  if (method === "turn/completed") return { message: "Codex turn completed.", report: true, metadata };
  if (method === "turn/failed") return { message: "Codex turn failed.", report: true, metadata };
  if (method === "error") {
    return {
      message: jsonStringAt(notification.raw, ["params", "error", "message"]) ?? "Codex app-server emitted an error.",
      report: true,
      metadata
    };
  }
  if (method === "item/started") {
    return { message: `Codex started ${itemType ?? "an item"}.`, report: true, metadata };
  }
  if (method === "item/completed") {
    return { message: `Codex completed ${itemType ?? "an item"}.`, report: true, metadata };
  }
  if (method === "turn/diff/updated") return { message: "Codex reported a diff update.", report: true, metadata };
  if (method === "thread/tokenUsage/updated") return { message: "Codex token usage updated.", report: true, metadata };
  if (method === "model/rerouted") return { message: "Codex rerouted the model.", report: true, metadata };
  return { message: `Codex notification: ${method}.`, report: false, metadata };
}

function formatCodexNotificationTranscriptLine(
  notification: CodexAppServerNotification,
  summary: ReturnType<typeof codexNotificationSummary>
) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    method: notification.method,
    message: summary.message,
    metadata: summary.metadata
  });
}

function sanitizeStepName(value: string) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "event";
}

function compactJson(value: unknown, maxChars = 1200) {
  if (value == null) return null;
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function jsonStringAt(value: unknown, keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function reserveLocalPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Unable to reserve a local port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Process did not exit within ${formatDuration(timeoutMs)}.`));
    }, timeoutMs);
    timeout.unref?.();
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function shouldEmitCommandActivity(step: string) {
  return (
    step === "codex" ||
    step.startsWith("codex_attempt_") ||
    step === "opencode" ||
    step.startsWith("opencode_attempt_") ||
    step === "verify" ||
    step === "scan" ||
    step === "dependencies"
  );
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
