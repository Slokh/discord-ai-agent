import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../config/env.js";
import { OpenRouterClient } from "../models/openrouter.js";
import { complete, progress, recordArtifact } from "./callbacks.js";
import { categoryForCodegenPhase, CodegenTaskError, diagnoseCodegenFailure, renderCodegenFailureDiagnosis, type CodegenFailureDiagnosis } from "./codegenFailureDiagnosis.js";
import { codeUpdateVerificationRepairPrompt, improvementReportRepairPrompt, renderCodegenContextPack } from "./codegenPrompts.js";
import { runCommand } from "./commands.js";
import { buildCodegenContextPack } from "./contextPack.js";
import { changedDependencyManifestFiles, codegenNpmScriptEnv, prepareDependencies, readDependencyManifestState } from "./dependencyCache.js";
import { readImprovementAssessmentResult, validatedImprovementTriage, type ImprovementAssessmentResult } from "./improvementAssessmentResult.js";
import { NANOCODEX_RUNTIME_LABEL, nanoCodexModel, runNanoCodex } from "./harness/nanocodex.js";
import type { AgentRunSummary, NanoCodexRunInput } from "./harness/types.js";
import { codeUpdateBranchName, codeUpdatePullRequestMetadata, codeUpdatePullRequestTitle } from "./prFormatting.js";
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
import { loadSandboxEnv, type SandboxEnv, type TaskTimings } from "./sandboxEnv.js";
import { productConfig } from "../config/env.js";
import { writeSandboxToolShims } from "./sandboxToolShims.js";
import { parseGitHubRepository } from "../github/repository.js";
import { conciseError, formatDuration, tail, uniqueStrings } from "./sandboxUtils.js";

type CacheSummary = {
  repo?: "hit" | "miss";
  dependencies?: "hit" | "miss";
  dependencyCacheKey?: string;
  dependencyFilesChanged?: string[];
  dependencyRefreshAfterCodegen?: boolean;
  toolShims?: string[];
};

export async function main() {
  const env = loadSandboxEnv();
  const timings: TaskTimings = {};
  const totalStartedAt = Date.now();
  try {
    const result = await runCodeUpdate(env, timings, totalStartedAt);
    const resultSummary = "resultSummary" in result ? result.resultSummary : null;
    await complete(env, {
      status: result.status,
      branchName: result.branchName,
      prUrl: result.prUrl,
      draft: result.draft,
      verifyPassed: result.verifyPassed,
      error: result.status === "no_changes" ? result.improvementAssessment?.summary ?? null : null,
      metadata: {
        timingsMs: result.timings,
        cache: result.cacheSummary,
        targetBranch: env.targetBranch,
        targetPullRequestNumber: env.targetPullRequestNumber,
        targetPullRequestUrl: env.targetPullRequestUrl,
        updatedExistingPullRequest: result.updatedExistingPullRequest,
        improvementAssessment: result.improvementAssessment ?? null,
        autoMergeEnabled: result.autoMergeEnabled,
        resultSummary,
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    timings.total = Date.now() - totalStartedAt;
    const diagnosis = diagnoseCodegenFailure({ error, timings });
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
  const branchSeedTitle = codeUpdatePullRequestTitle(env.taskTitle);
  const generatedBranchName = codeUpdateBranchName(branchSeedTitle, env.taskId);
  const cache = sandboxCachePaths(env, owner, repo);
  const cacheSummary: CacheSummary = {};
  await fs.mkdir(cache.workspacesDir, { recursive: true });
  await pruneOldWorkspaceDirs(cache.workspacesDir).catch((error) => {
    console.error("Failed to prune old sandbox workspaces", error);
  });
  const workRoot = await fs.mkdtemp(path.join(cache.workspacesDir, "task-"));
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

    const dependencyStateBeforeCodegen = await readDependencyManifestState(checkoutDir);
    if (env.taskType === "diagnosis") {
      await progress(env, "dependencies_skipped", "Skipping dependency installation for read-only diagnosis.", { taskType: env.taskType });
    } else {
      await timedPhase(env, timings, "dependencies", "Preparing dependencies from the shared sandbox cache.", async () => {
        const dependencyCache = await prepareDependencies({ env, cache, checkoutDir });
        cacheSummary.dependencies = dependencyCache.cacheStatus;
        cacheSummary.dependencyCacheKey = dependencyCache.lockHash;
      });
    }

    const toolShimDir = path.join(workRoot, "tool-shims");
    await timedPhase(env, timings, "toolShims", "Installing sandbox helper tool shims for the codegen harness.", async () => {
      const shims = await writeSandboxToolShims(toolShimDir, env);
      cacheSummary.toolShims = shims;
      await progress(env, "tool_shims_ready", "Sandbox helper tools are available for NanoCodex.", { toolShims: shims, harness: NANOCODEX_RUNTIME_LABEL });
    });

    const contextPack = await timedPhase(env, timings, "context", "Building codegen request context.", async () =>
      buildCodegenContextPack(checkoutDir, env.taskRequest)
    );
    const nanoCodexInput: NanoCodexRunInput = {
      env,
      checkoutDir,
      gitEnv,
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

    const nanoCodexSummary = await runNanoCodexPhase({
      env,
      timings,
      phase: env.taskType === "improvement_report" ? "improvement_triage" : undefined,
      message: env.taskType === "improvement_report" ? "Running evidence-only improvement assessment." : undefined,
      input: {
        ...nanoCodexInput,
        attempt: 1,
        totalAttempts: 2,
        ...(env.taskType === "improvement_report" ? {
          instructions: "Assess the report using retained evidence. Keep the checkout unchanged and write the required structured result. Do not implement a fix in this phase."
        } : {})
      }
    });

    let improvementAssessment: ImprovementAssessmentResult | null = null;
    if (env.taskType === "improvement_report") {
      const triageChangeState = await readGitChangeState(checkoutDir, baseRevision);
      if (triageChangeState.hasChanges) {
        throw new CodegenTaskError("command_failed", "improvement_triage", "Improvement assessment modified the checkout before a defect was confirmed; refusing to continue.");
      }
      const triageResult = validatedImprovementTriage(await readImprovementAssessmentResult(env.improvementAssessmentResultPath));
      improvementAssessment = triageResult;
      await recordArtifact(env, {
        kind: "diagnostic",
        name: "Improvement assessment",
        content: JSON.stringify(triageResult, null, 2),
        contentType: "application/json"
      });
      await progress(env, "improvement_triage_verdict", triageResult.summary, { disposition: triageResult.disposition });
      if (triageResult.disposition !== "confirmed_unfixed") {
        timings.total = Date.now() - totalStartedAt;
        return noChangeImprovementResult(triageResult, timings, cacheSummary);
      }

      await fs.rm(env.improvementAssessmentResultPath, { force: true });
      await runNanoCodexPhase({
        env,
        timings,
        phase: "improvement_repair",
        message: "The defect is confirmed; running the gated repair phase.",
        input: {
          ...nanoCodexInput,
          attempt: 2,
          totalAttempts: 2,
          prompt: improvementReportRepairPrompt(env, triageResult, contextPack),
          instructions: "Repair only the confirmed defect, add focused regression coverage, and write the required structured repair result."
        }
      });
      improvementAssessment = await readImprovementAssessmentResult(env.improvementAssessmentResultPath);
    }

    await progress(env, "diff", "Checking whether NanoCodex produced real code changes.", {
      harness: NANOCODEX_RUNTIME_LABEL,
      baseRevision
    });
    const changeState = await readGitChangeState(checkoutDir, baseRevision);
    if (!changeState.hasChanges) {
      if (env.taskType === "diagnosis") {
        const resultSummary = nanoCodexSummary.attempts.at(-1)?.finalResponse?.trim();
        if (!resultSummary) throw new Error("Read-only diagnosis finished without a result.");
        timings.total = Date.now() - totalStartedAt;
        await progress(env, "diagnosis_complete", resultSummary, { taskType: env.taskType });
        return {
          status: "succeeded" as const,
          branchName: null,
          prUrl: null,
          draft: null,
          verifyPassed: true,
          updatedExistingPullRequest: false,
          improvementAssessment: null,
          autoMergeEnabled: false,
          resultSummary,
          timings,
          cacheSummary
        };
      }
      if (improvementAssessment && improvementAssessment.disposition !== "confirmed_fixed") {
        timings.total = Date.now() - totalStartedAt;
        return noChangeImprovementResult(improvementAssessment, timings, cacheSummary);
      }
      throw new CodegenTaskError("no_diff", "diff", "Agent task produced no diff; no PR will be opened.");
    }
    if (env.taskType === "improvement_report" && improvementAssessment && improvementAssessment.disposition !== "confirmed_fixed") {
      timings.total = Date.now() - totalStartedAt;
      await progress(env, "improvement_repair_blocked", improvementAssessment.summary, { disposition: improvementAssessment.disposition });
      return noChangeImprovementResult(improvementAssessment, timings, cacheSummary);
    }
    if (env.taskType === "improvement_report" && (improvementAssessment?.disposition !== "confirmed_fixed" || !improvementAssessment.regression)) {
      throw new Error("Improvement task produced code changes without a confirmed_fixed result and executable regression contract; refusing to push.");
    }
    await progress(env, "diff_detected", "Detected generated code changes.", gitChangeStateMetadata(changeState));
    const dependencyStateAfterCodegen = await readDependencyManifestState(checkoutDir);
    const dependencyFilesChanged = changedDependencyManifestFiles(dependencyStateBeforeCodegen, dependencyStateAfterCodegen);
    if (dependencyFilesChanged.length > 0) {
      cacheSummary.dependencyFilesChanged = dependencyFilesChanged;
      cacheSummary.dependencyRefreshAfterCodegen = true;
      await timedPhase(
        env,
        timings,
        "dependenciesPostCodegen",
        "Dependency files changed; refreshing dependencies before PR creation.",
        async () => {
          const dependencyCache = await prepareDependencies({
            env,
            cache,
            checkoutDir,
            reason: "dependency_files_changed_after_nanocodex"
          });
          cacheSummary.dependencies = dependencyCache.cacheStatus;
          cacheSummary.dependencyCacheKey = dependencyCache.lockHash;
        },
        { dependencyFilesChanged }
      );
    }

    const npmScriptEnv = codegenNpmScriptEnv(process.env);
    npmScriptEnv.NODE_OPTIONS = [npmScriptEnv.NODE_OPTIONS, `--max-old-space-size=${productConfig.sandbox.nodeHeapMb}`].filter(Boolean).join(" ");
    let verification = await runPrePublicationVerification({ env, timings, checkoutDir, npmScriptEnv });
    if (verification.exitCode !== 0) {
      const failureOutput = tail(`${verification.stdout}\n${verification.stderr}`, 12_000);
      await recordArtifact(env, {
        kind: "diagnostic",
        name: "Pre-publication verification failure",
        content: failureOutput,
        contentType: "text/plain",
        metadata: { command: "npm run verify", exitCode: verification.exitCode }
      });
      await progress(env, "verify_repair", "Verification failed; asking NanoCodex for one focused repair.", {
        command: "npm run verify",
        exitCode: verification.exitCode
      });
      await runNanoCodexPhase({
        env,
        timings,
        phase: "nanocodex_repair",
        message: "Running NanoCodex to repair the failed verification.",
        input: {
          ...nanoCodexInput,
          attempt: 2,
          totalAttempts: 2,
          prompt: codeUpdateVerificationRepairPrompt(env, {
            command: "npm run verify",
            output: failureOutput,
            contextPack
          })
        }
      });
      verification = await runPrePublicationVerification({ env, timings, checkoutDir, npmScriptEnv, retry: true });
      if (verification.exitCode !== 0) {
        const commandFailure = new Error(`npm run verify exited ${verification.exitCode}: ${tail(`${verification.stdout}\n${verification.stderr}`, 2_000)}`) as Error & { exitCode?: number; stderr?: string };
        commandFailure.exitCode = verification.exitCode;
        commandFailure.stderr = verification.stderr;
        throw new CodegenTaskError("verification", "verify", "Full repository verification failed after the repair attempt; refusing to publish generated changes.", { cause: commandFailure });
      }
    }

    const finalChangeState = await readGitChangeState(checkoutDir, baseRevision);
    if (!finalChangeState.hasChanges) {
      throw new CodegenTaskError("no_diff", "verify", "Verification repair removed all generated changes; no PR will be opened.");
    }
    const diffStat = await runCommand("git", ["diff", "--stat", baseRevision, "--"], { cwd: checkoutDir, taskEnv: env, step: "diff_stat" });
    await recordArtifact(env, {
      kind: "diff",
      name: "Git diff stat",
      content: diffStat.stdout,
      contentType: "text/plain",
      metadata: { command: `git diff --stat ${baseRevision} --`, ...gitChangeStateMetadata(finalChangeState) }
    });
    const diffPatch = await runCommand("git", ["diff", "--no-ext-diff", baseRevision, "--"], { cwd: checkoutDir, taskEnv: env, step: "diff_patch" });
    await recordArtifact(env, {
      kind: "diff",
      name: "Git patch",
      content: diffPatch.stdout,
      contentType: "text/x-diff",
      metadata: { command: `git diff --no-ext-diff ${baseRevision} --`, ...gitChangeStateMetadata(finalChangeState) }
    });

    const prMetadata = target.pullRequestNumber
      ? null
      : await timedPhase(
          env,
          timings,
          "prMetadata",
          "Deriving public pull-request metadata from the verified code diff.",
          async () => codeUpdatePullRequestMetadata({
            diffStat: diffStat.stdout,
            diffPatch: diffPatch.stdout,
            complete: async ({ systemPrompt, userPrompt }) => {
              const client = new OpenRouterClient({
                apiKey: env.openRouterApiKey,
                baseUrl: env.openRouterBaseUrl,
                chatModel: env.openRouterCodegenModel,
              } as AppConfig["openRouter"]);
              const result = await client.chat({
                model: env.openRouterCodegenModel,
                messages: [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: userPrompt },
                ],
                reasoningEffort: "low",
                maxTokens: 700,
                retryPolicy: "cheap",
              });
              return {
                content: result.content,
                model: result.model,
                estimatedCostUsd: result.estimatedCostUsd,
              };
            },
          }),
        );
    if (prMetadata) {
      await progress(env, "pr_metadata_ready", "Prepared pull-request title and body from the public code diff.", {
        source: prMetadata.source,
        model: prMetadata.model ?? null,
        estimatedCostUsd: prMetadata.estimatedCostUsd ?? null,
        fallbackReason: prMetadata.fallbackReason ?? null,
      });
    }
    const prTitle = prMetadata?.title ?? branchSeedTitle;

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
      if (!prMetadata) throw new Error("Pull-request metadata was not prepared for a new PR.");
      const pr = await timedPhase(env, timings, "pr", target.updateExistingBranch ? "Opening a pull request for the target branch." : "Opening the GitHub pull request.", async () =>
        octokit.pulls.create({
          owner,
          repo,
          title: prTitle,
          head: branchName,
          base: env.githubBaseBranch,
          draft,
          body: prMetadata.body
        }), { draft, branchName, updateExistingBranch: target.updateExistingBranch }
      );
      prNumber = pr.data.number;
      prUrl = pr.data.html_url;
    }

    let autoMergeEnabled = false;
    if (env.taskType === "improvement_report" && prNumber) {
      const pullRequest = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
      await octokit.graphql(
        `mutation EnableAutoMerge($pullRequestId: ID!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: SQUASH}) {
            pullRequest { number }
          }
        }`,
        { pullRequestId: pullRequest.data.node_id },
      );
      autoMergeEnabled = true;
      await progress(env, "auto_merge_enabled", "Required checks will automatically merge and deploy this repair.", { prUrl, prNumber });
    }

    timings.total = Date.now() - totalStartedAt;
    if (prMetadata) {
      await recordArtifact(env, {
        kind: "pr_body",
        name: "Pull request body",
        content: prMetadata.body,
        contentType: "text/markdown",
        metadata: {
          prUrl,
          prNumber,
          draft,
          verifyPassed: null,
          updatedExistingPullRequest,
          source: prMetadata.source,
          model: prMetadata.model ?? null,
          estimatedCostUsd: prMetadata.estimatedCostUsd ?? null,
        }
      });
    }
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
      status: "succeeded" as const,
      branchName,
      prUrl,
      draft,
      verifyPassed: true,
      updatedExistingPullRequest,
      improvementAssessment,
      autoMergeEnabled,
      timings,
      cacheSummary
    };
  } finally {
    await progress(env, "cleanup", "Cleaning up the ephemeral sandbox checkout.").catch(() => undefined);
    await removeCachedWorktree(cache.mirrorDir, checkoutDir).catch(() => undefined);
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function noChangeImprovementResult(
  improvementAssessment: ImprovementAssessmentResult,
  timings: TaskTimings,
  cacheSummary: CacheSummary,
) {
  return {
    status: "no_changes" as const,
    branchName: null,
    prUrl: null,
    draft: null,
    verifyPassed: null,
    updatedExistingPullRequest: false,
    improvementAssessment,
    autoMergeEnabled: false,
    timings,
    cacheSummary
  };
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
    if (error instanceof CodegenTaskError || (error instanceof Error && error.name === "CodegenNoDiffError")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CodegenTaskError(categoryForCodegenPhase(step), step, message, { cause: error });
  }
}

async function runPrePublicationVerification(input: {
  env: SandboxEnv;
  timings: TaskTimings;
  checkoutDir: string;
  npmScriptEnv: NodeJS.ProcessEnv;
  retry?: boolean;
}) {
  const step = input.retry ? "verify_repair" : "verify";
  return timedPhase(
    input.env,
    input.timings,
    step,
    input.retry
      ? "Running full repository verification after the NanoCodex repair."
      : "Running full repository verification before publication.",
    async () =>
      runCommand("npm", ["run", "verify"], {
        cwd: input.checkoutDir,
        allowFailure: true,
        taskEnv: input.env,
        step,
        env: input.npmScriptEnv
      })
  );
}

async function runNanoCodexPhase(input: {
  env: SandboxEnv;
  timings: TaskTimings;
  input: NanoCodexRunInput;
  phase?: string;
  message?: string;
}) {
  const phase = input.phase ?? "nanocodex";
  return timedPhase(
    input.env,
    input.timings,
    phase,
    input.message ?? "Running NanoCodex to implement the requested change.",
    async () => {
      const summary = await runNanoCodex(input.input);
      await recordAgentAttemptSummary(input.env, `NanoCodex ${phase.replaceAll("_", " ")} summary`, summary);
      return summary;
    },
    { model: `openai/${nanoCodexModel(input.env.openRouterCodegenModel)}`, harness: NANOCODEX_RUNTIME_LABEL }
  );
}

async function recordAgentAttemptSummary(env: SandboxEnv, name: string, summary: AgentRunSummary) {
  await recordArtifact(env, {
    kind: "diagnostic",
    name,
    content: JSON.stringify(summary, null, 2),
    contentType: "application/json",
    metadata: {
      harness: NANOCODEX_RUNTIME_LABEL,
      attempts: summary.attempts.length,
      producedDiff: summary.attempts.some((attempt) => attempt.producedDiff)
    }
  });
}
