import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { slugify } from "../util/text.js";

const MAX_CAPTURED_COMMAND_OUTPUT = 40_000;
const STALE_WORKSPACE_MS = 6 * 60 * 60 * 1000;

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

    await timedPhase(env, timings, "codex", "Running Codex to implement the requested change.", async () => {
      await runCommand(
        process.env.CODEX_BIN || "codex",
        [
          "exec",
          "--ephemeral",
          "-C",
          checkoutDir,
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "never",
          "-m",
          env.openRouterChatModel,
          "-"
        ],
        {
          cwd: checkoutDir,
          env: codexEnv(env, gitEnv, workRoot, toolShimDir),
          input: codeUpdatePrompt(env),
          taskEnv: env,
          step: "codex"
        }
      );
    }, { model: env.openRouterChatModel });

    await progress(env, "diff", "Checking whether Codex produced a real code diff.");
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: checkoutDir, taskEnv: env, step: "diff" });
    if (!status.stdout.trim()) {
      throw new Error("Agent task produced no diff; no PR will be opened.");
    }

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
    const pr = await timedPhase(env, timings, "pr", "Opening the GitHub pull request.", async () =>
      octokit.pulls.create({
        owner,
        repo,
        title: `Update Discord AI Agent: ${env.taskTitle}`,
        head: branchName,
        base: env.githubBaseBranch,
        draft,
        body: pullRequestBody({ env, verifyPassed: verify.exitCode === 0, timings, cacheSummary })
      }), { draft }
    );

    timings.total = Date.now() - totalStartedAt;
    await octokit.pulls
      .update({
        owner,
        repo,
        pull_number: pr.data.number,
        body: pullRequestBody({ env, verifyPassed: verify.exitCode === 0, timings, cacheSummary })
      })
      .catch((error) => {
        console.error("Failed to update PR body with final timings", error);
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
  });
  return { cacheStatus };
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
      'sandbox_mode = "workspace-write"',
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

function codeUpdatePrompt(env: SandboxEnv) {
  return [
    "You are implementing a Discord-requested update to this TypeScript Discord AI Agent repository.",
    "",
    "Requirements:",
    "- Read the relevant code before editing.",
    "- Implement the requested behavior with a real code diff.",
    "- Keep changes focused and consistent with the existing architecture.",
    "- Add or update tests for the changed behavior.",
    "- Do not commit, push, open a PR, or edit GitHub state yourself.",
    "- Do not add request-only documentation artifacts; the PR body records the request.",
    "- Before finishing, run the most relevant checks you can.",
    "- Helper CLIs are available on PATH: agent-task-context, agent-cache-info, and agent-progress <step> <message>.",
    "",
    `Task ID: ${env.taskId}`,
    `Requested by: ${env.requestedBy}`,
    "",
    "Requested update:",
    env.taskRequest.trim(),
    ""
  ].join("\n");
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

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    allowFailure?: boolean;
    taskEnv?: SandboxEnv;
    step?: string;
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
  const activityTimer =
    options.taskEnv && shouldEmitCommandActivity(step)
      ? setInterval(() => {
          void progress(options.taskEnv!, `${step}_activity`, `${step} is still running after ${formatDuration(Date.now() - startedAt)}.`, {
            command,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
            durationMs: Date.now() - startedAt
          }).catch(() => undefined);
        }, 30_000)
      : undefined;
  activityTimer?.unref?.();

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout = appendLimited(stdout, text);
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = appendLimited(stderr, text);
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
  }
  await recordCommand(options.taskEnv, {
    step,
    command: `${command} ${redactedArgs(command, args).join(" ")}`.trim(),
    exitCode,
    outputTail: stdout,
    errorTail: stderr,
    durationMs: Date.now() - startedAt
  });
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

function appendLimited(current: string, next: string) {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURED_COMMAND_OUTPUT) return combined;
  return combined.slice(combined.length - MAX_CAPTURED_COMMAND_OUTPUT);
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
