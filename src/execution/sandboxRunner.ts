import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { slugify } from "../util/text.js";

const MAX_CAPTURED_COMMAND_OUTPUT = 40_000;

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
      metadata: { timingsMs: result.timings }
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
  await fs.mkdir(cache.workspacesDir, { recursive: true });
  const workRoot = await fs.mkdtemp(path.join(cache.workspacesDir, "task-"));
  const checkoutDir = path.join(workRoot, "repo");
  const gitEnv = await gitAuthEnv(env.githubToken, workRoot);

  try {
    if (env.sandboxStartedAtMs != null) {
      timings.sandboxStartup = Math.max(0, Date.now() - env.sandboxStartedAtMs);
      await progress(env, "sandbox_acquired", "Sandbox process started.", { durationMs: timings.sandboxStartup });
    }

    await timedPhase(env, timings, "repo", "Refreshing cached repository mirror and creating a task worktree.", async () => {
      await prepareCachedWorktree({
        env,
        cache,
        owner,
        repo,
        checkoutDir,
        gitEnv,
        workRoot
      });
    });

    await progress(env, "branch", `Creating implementation branch ${branchName}.`, { branchName });
    await runCommand("git", ["checkout", "-b", branchName], { cwd: checkoutDir, taskEnv: env, step: "branch" });

    await timedPhase(env, timings, "dependencies", "Preparing dependencies from the shared sandbox cache.", async () => {
      await prepareDependencies({ env, cache, checkoutDir });
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
          env: codexEnv(env, gitEnv, workRoot),
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
        body: pullRequestBody({ env, verifyPassed: verify.exitCode === 0, timings })
      }), { draft }
    );

    timings.total = Date.now() - totalStartedAt;
    await octokit.pulls
      .update({
        owner,
        repo,
        pull_number: pr.data.number,
        body: pullRequestBody({ env, verifyPassed: verify.exitCode === 0, timings })
      })
      .catch((error) => {
        console.error("Failed to update PR body with final timings", error);
      });
    await progress(env, "task_complete", "Code update task finished.", { durationMs: timings.total, timingsMs: timings });

    return {
      branchName,
      prUrl: pr.data.html_url,
      draft,
      verifyPassed: verify.exitCode === 0,
      timings
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
    workspacesDir: path.join(rootDir, "workspaces"),
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
}) {
  await fs.mkdir(input.cache.reposDir, { recursive: true });
  await fs.mkdir(input.cache.locksDir, { recursive: true });
  const repoUrl = `https://github.com/${input.owner}/${input.repo}.git`;

  await withDirectoryLock(input.cache.repoLockDir, async () => {
    if (await pathExists(path.join(input.cache.mirrorDir, "HEAD"))) {
      await progress(input.env, "repo_refresh", "Fetching latest changes into the cached repository mirror.", {
        mirrorDir: input.cache.mirrorDir
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
      await progress(input.env, "repo_seed", "Seeding the cached repository mirror.", { mirrorDir: input.cache.mirrorDir });
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
}

async function prepareDependencies(input: { env: SandboxEnv; cache: SandboxCachePaths; checkoutDir: string }) {
  await fs.mkdir(input.cache.npmCacheDir, { recursive: true });
  await fs.mkdir(input.cache.nodeModulesDir, { recursive: true });
  await fs.mkdir(input.cache.locksDir, { recursive: true });
  const lockHash = await dependencyCacheKey(input.checkoutDir);
  const nodeModulesPath = path.join(input.checkoutDir, "node_modules");
  const cachedNodeModulesPath = path.join(input.cache.nodeModulesDir, lockHash);
  const lockDir = path.join(input.cache.locksDir, `${lockHash}.node-modules.lock`);

  if (await pathExists(cachedNodeModulesPath)) {
    await progress(input.env, "dependency_cache_hit", "Restoring node_modules from the dependency cache.", { lockHash });
    await fs.rm(nodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(cachedNodeModulesPath, nodeModulesPath, { recursive: true });
    return;
  }

  await withDirectoryLock(lockDir, async () => {
    if (await pathExists(cachedNodeModulesPath)) {
      await progress(input.env, "dependency_cache_hit", "Restoring node_modules from the dependency cache.", { lockHash });
      await fs.rm(nodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.cp(cachedNodeModulesPath, nodeModulesPath, { recursive: true });
      return;
    }

    await progress(input.env, "dependency_cache_miss", "Dependency cache miss; installing with persistent npm cache.", { lockHash });
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
}

async function dependencyCacheKey(checkoutDir: string) {
  const lockfile = await fs.readFile(path.join(checkoutDir, "package-lock.json"));
  return `${process.version.replace(/^v/, "node-")}-${sha256Buffer(lockfile).slice(0, 24)}`;
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

function codexEnv(env: SandboxEnv, baseEnv: NodeJS.ProcessEnv, workRoot: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CODEX_HOME: path.join(workRoot, ".codex"),
    OPENROUTER_API_KEY: env.openRouterApiKey
  };
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
    "",
    `Task ID: ${env.taskId}`,
    `Requested by: ${env.requestedBy}`,
    "",
    "Requested update:",
    env.taskRequest.trim(),
    ""
  ].join("\n");
}

function pullRequestBody(input: { env: SandboxEnv; verifyPassed: boolean; timings: TaskTimings }) {
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
    ...formatTimingLines(input.timings)
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
    ["Codex execution", timings.codex],
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
