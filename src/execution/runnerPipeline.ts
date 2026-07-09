import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { complete, progress, recordArtifact } from "./callbacks.js";
import { diagnoseCodegenFailure, renderCodegenFailureDiagnosis, type CodegenFailureDiagnosis } from "./codegenFailureDiagnosis.js";
import { renderCodegenContextPack } from "./codegenPrompts.js";
import { runCommand } from "./commands.js";
import { buildCodegenContextPack } from "./contextPack.js";
import { changedDependencyManifestFiles, codegenNpmScriptEnv, prepareDependencies, readDependencyManifestState } from "./dependencyCache.js";
import { codexHarnessAdapter, codexHomePathForTask } from "./harness/codex.js";
import { openCodeHarnessAdapter, openCodeModelId } from "./harness/opencode.js";
import type { AgentRunSummary, CodegenHarnessAdapter, CodegenHarnessRunInput } from "./harness/types.js";
import { codeUpdateBranchName, codeUpdatePullRequestBody, codeUpdatePullRequestTitle } from "./prFormatting.js";
import {
  assertCodeUpdatePushAllowed,
  branchPushRef,
  checkoutExistingTargetBranch,
  gitAuthEnv,
  gitChangeStateMetadata,
  gitRevision,
  prepareCachedWorktree,
  pruneOldWorkspaceDirs,
  readGitChangeState,
  removeCachedWorktree,
  resolveCodeUpdateTarget,
  sandboxCachePaths
} from "./repoWorkspace.js";
import { codegenHarnessDisplayName, loadSandboxEnv, parseGitHubRepository, type SandboxEnv, type TaskTimings } from "./sandboxEnv.js";
import { conciseError, formatDuration, uniqueStrings } from "./sandboxUtils.js";

type CacheSummary = {
  repo?: "hit" | "miss";
  dependencies?: "hit" | "miss";
  dependencyCacheKey?: string;
  dependencyFilesChanged?: string[];
  dependencyRefreshAfterCodex?: boolean;
  toolShims?: string[];
};

export async function main() {
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
      metadata: {
        timingsMs: result.timings,
        cache: result.cacheSummary,
        targetBranch: env.targetBranch,
        targetPullRequestNumber: env.targetPullRequestNumber,
        targetPullRequestUrl: env.targetPullRequestUrl,
        updatedExistingPullRequest: result.updatedExistingPullRequest
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    timings.total = Date.now() - totalStartedAt;
    const diagnosis = diagnoseCodegenFailure({ error, timings, harness: env.codegenHarness });
    await recordCodegenFailureDiagnosis(env, diagnosis).catch((diagnosisError) => {
      console.error("Failed to record codegen failure diagnosis", diagnosisError);
    });
    await complete(env, {
      status: diagnosis.status,
      error: message,
      metadata: { timingsMs: timings, failureDiagnosis: diagnosis }
    }).catch((callbackError) => {
      console.error("Failed to post terminal task callback", callbackError);
    });
    throw error;
  }
}

async function recordCodegenFailureDiagnosis(env: SandboxEnv, diagnosis: CodegenFailureDiagnosis) {
  await progress(env, "failure_diagnosis", diagnosis.summary, {
    category: diagnosis.category,
    status: diagnosis.status,
    failedPhase: diagnosis.failedPhase,
    slowestPhase: diagnosis.slowestPhase,
    nextAction: diagnosis.nextAction
  }).catch(() => undefined);
  await recordArtifact(env, {
    kind: "diagnostic",
    name: "Codegen failure diagnosis",
    content: renderCodegenFailureDiagnosis(diagnosis),
    contentType: "text/markdown",
    metadata: {
      category: diagnosis.category,
      status: diagnosis.status,
      failedPhase: diagnosis.failedPhase,
      slowestPhase: diagnosis.slowestPhase
    }
  });
}

export async function runCodeUpdate(env: SandboxEnv, timings: TaskTimings, totalStartedAt: number) {
  const { owner, repo } = parseGitHubRepository(env.githubRepository);
  const prTitle = codeUpdatePullRequestTitle(env.taskTitle);
  const generatedBranchName = codeUpdateBranchName(prTitle, env.taskId);
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
  const octokit = new Octokit({ auth: env.githubToken });

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

    const target = await resolveCodeUpdateTarget({
      env,
      octokit,
      owner,
      repo,
      generatedBranchName
    });
    const branchName = target.branchName;
    if (target.updateExistingBranch) {
      await progress(env, "branch", `Checking out target branch ${branchName}.`, {
        branchName,
        generatedBranchName,
        targetPullRequestNumber: target.pullRequestNumber,
        targetPullRequestUrl: target.pullRequestUrl,
        updateExistingBranch: true
      });
      await checkoutExistingTargetBranch({ env, checkoutDir, gitEnv, branchName });
    } else {
      await progress(env, "branch", `Creating implementation branch ${branchName}.`, { branchName });
      await runCommand("git", ["checkout", "-b", branchName], { cwd: checkoutDir, taskEnv: env, step: "branch" });
    }
    const baseRevision = await gitRevision(checkoutDir, "HEAD");

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

    const harnessAdapter = env.codegenHarness === "opencode" ? openCodeHarnessAdapter : codexHarnessAdapter;
    await progress(env, "configure", `Writing ephemeral ${codegenHarnessDisplayName(env.codegenHarness)} configuration.`, { harness: env.codegenHarness });
    await harnessAdapter.writeConfig({ env, checkoutDir, codexHome, opencodeHome });

    const contextPack = await timedPhase(env, timings, "context", "Building codegen request context.", async () =>
      buildCodegenContextPack(checkoutDir, env.taskRequest)
    );
    const harnessInput: CodegenHarnessRunInput = {
      env,
      checkoutDir,
      gitEnv,
      workRoot,
      codexHome,
      opencodeHome,
      toolShimDir,
      contextPack,
      baseRevision
    };
    const renderedContextPack = renderCodegenContextPack(contextPack);
    await recordArtifact(env, {
      kind: "diagnostic",
      name: "Codegen request context",
      content: renderedContextPack,
      contentType: "text/plain",
      metadata: {
        files: uniqueStrings([
          ...(contextPack.suggestedFiles?.map((file) => file.path) ?? []),
          ...contextPack.projectMap.flatMap((entry) => entry.files)
        ])
      }
    });

    await runSelectedCodegenHarness({ env, timings, adapter: harnessAdapter, input: harnessInput });

    await progress(env, "diff", `Checking whether ${codegenHarnessDisplayName(env.codegenHarness)} produced real code changes.`, {
      harness: env.codegenHarness,
      baseRevision
    });
    const changeState = await readGitChangeState(checkoutDir, baseRevision);
    if (!changeState.hasChanges) {
      throw new Error("Agent task produced no diff; no PR will be opened.");
    }
    await progress(env, "diff_detected", "Detected generated code changes.", gitChangeStateMetadata(changeState));
    const diffStat = await runCommand("git", ["diff", "--stat", baseRevision, "--"], { cwd: checkoutDir, taskEnv: env, step: "diff_stat" });
    await recordArtifact(env, {
      kind: "diff",
      name: "Git diff stat",
      content: diffStat.stdout,
      contentType: "text/plain",
      metadata: { command: `git diff --stat ${baseRevision} --`, ...gitChangeStateMetadata(changeState) }
    });
    const diffPatch = await runCommand("git", ["diff", "--no-ext-diff", baseRevision, "--"], { cwd: checkoutDir, taskEnv: env, step: "diff_patch" });
    await recordArtifact(env, {
      kind: "diff",
      name: "Git patch",
      content: diffPatch.stdout,
      contentType: "text/x-diff",
      metadata: { command: `git diff --no-ext-diff ${baseRevision} --`, ...gitChangeStateMetadata(changeState) }
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
        "Dependency files changed; refreshing dependencies before PR creation.",
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
    const scan = await timedPhase(env, timings, "scan", "Running release scan before pushing generated changes.", async () =>
      runCommand("npm", ["run", "scan:release"], { cwd: checkoutDir, allowFailure: true, taskEnv: env, step: "scan", env: npmScriptEnv })
    );
    if (scan.exitCode !== 0) {
      throw new Error("Release scan failed after agent task; refusing to push generated changes.");
    }

    const preCommitChangeState = await readGitChangeState(checkoutDir, baseRevision);
    if (!preCommitChangeState.hasChanges) {
      throw new Error("Agent task changes disappeared before commit; no PR will be opened.");
    }
    if (preCommitChangeState.hasWorkingTreeChanges) {
      await progress(env, "commit", "Committing generated working-tree changes.", gitChangeStateMetadata(preCommitChangeState));
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
    } else {
      await progress(env, "commit_skipped", "Generated changes were already committed by the coding harness; pushing existing commits.", gitChangeStateMetadata(preCommitChangeState));
    }
    await timedPhase(env, timings, "push", target.updateExistingBranch ? "Pushing changes to the target branch." : "Pushing the generated branch to GitHub.", async () => {
      assertCodeUpdatePushAllowed({
        branchName,
        baseBranch: env.githubBaseBranch,
        hasResolvedPullRequest: target.pullRequestNumber != null
      });
      await runCommand("git", ["push", "origin", `HEAD:${branchPushRef(branchName)}`], { cwd: checkoutDir, env: gitEnv, taskEnv: env, step: "push" });
    }, { branchName, targetPullRequestNumber: target.pullRequestNumber, updateExistingBranch: target.updateExistingBranch });

    const draft = false;
    const finalPrBody = codeUpdatePullRequestBody({ env });
    let prUrl: string;
    let prNumber: number | null = target.pullRequestNumber;
    const updatedExistingPullRequest = Boolean(target.pullRequestNumber);
    if (target.pullRequestNumber) {
      const existingPr = await timedPhase(
        env,
        timings,
        "pr_update",
        `Confirming existing pull request #${target.pullRequestNumber}.`,
        async () => octokit.pulls.get({ owner, repo, pull_number: target.pullRequestNumber! }),
        { pullRequestNumber: target.pullRequestNumber, branchName }
      );
      prUrl = existingPr.data.html_url ?? target.pullRequestUrl ?? `https://github.com/${owner}/${repo}/pull/${target.pullRequestNumber}`;
    } else {
      const initialPrBody = codeUpdatePullRequestBody({ env });
      const pr = await timedPhase(env, timings, "pr", target.updateExistingBranch ? "Opening a pull request for the target branch." : "Opening the GitHub pull request.", async () =>
        octokit.pulls.create({
          owner,
          repo,
          title: prTitle,
          head: branchName,
          base: env.githubBaseBranch,
          draft,
          body: initialPrBody
        }), { draft, branchName, updateExistingBranch: target.updateExistingBranch }
      );
      prNumber = pr.data.number;
      prUrl = pr.data.html_url;
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
    }

    timings.total = Date.now() - totalStartedAt;
    await recordArtifact(env, {
      kind: "pr_body",
      name: "Pull request body",
      content: finalPrBody,
      contentType: "text/markdown",
      metadata: { prUrl, prNumber, draft, verifyPassed: null, updatedExistingPullRequest }
    });
    await progress(env, "task_complete", "Code update task finished.", {
      durationMs: timings.total,
      timingsMs: timings,
      cache: cacheSummary,
      prUrl,
      prNumber,
      branchName,
      updatedExistingPullRequest
    });

    return {
      branchName,
      prUrl,
      draft,
      verifyPassed: null,
      updatedExistingPullRequest,
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

async function runSelectedCodegenHarness(input: {
  env: SandboxEnv;
  timings: TaskTimings;
  adapter: CodegenHarnessAdapter;
  input: CodegenHarnessRunInput;
}) {
  if (input.adapter.name === "opencode") {
    await timedPhase(
      input.env,
      input.timings,
      "opencode",
      "Running OpenCode to implement the requested change.",
      async () => {
        const summary = await input.adapter.run(input.input);
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
      const summary = await input.adapter.run(input.input);
      await recordAgentAttemptSummary(input.env, "Codex attempt summary", summary, "codex-app-server");
    },
    { model: input.env.openRouterCodegenModel, harness: "codex-app-server", fallbackHarness: "codex-exec-json" }
  );
}

async function recordAgentAttemptSummary(env: SandboxEnv, name: string, summary: AgentRunSummary, harness: string) {
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

export async function writeSandboxToolShims(toolShimDir: string): Promise<string[]> {
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
