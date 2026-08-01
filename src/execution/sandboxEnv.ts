import os from "node:os";
import path from "node:path";
import type { SandboxEnv } from "./types.js";

export type { SandboxEnv, TaskTimings } from "./types.js";

export function loadSandboxEnv(): SandboxEnv {
  const taskType = process.env.TASK_TYPE === "bug_report"
    ? "bug_report"
    : process.env.TASK_TYPE === "diagnosis"
      ? "diagnosis"
      : "code_update";
  return {
    taskType,
    taskId: requiredEnv("TASK_ID"),
    traceId: requiredEnv("TRACE_ID"),
    sandboxRunId: requiredEnv("SANDBOX_RUN_ID"),
    taskTitle: requiredEnv("TASK_TITLE"),
    taskRequest: requiredEnv("TASK_REQUEST"),
    bugReportResultPath: process.env.BUG_REPORT_RESULT_PATH || path.join(os.tmpdir(), `${requiredEnv("TASK_ID")}-bug-report-result.json`),
    requestedBy: requiredEnv("REQUESTED_BY"),
    targetBranch: optionalEnv("TARGET_BRANCH"),
    targetPullRequestNumber: numberEnv("TARGET_PULL_REQUEST_NUMBER"),
    targetPullRequestUrl: optionalEnv("TARGET_PULL_REQUEST_URL"),
    controlPlaneInternalUrl: requiredEnv("CONTROL_PLANE_INTERNAL_URL").replace(/\/$/, ""),
    taskToken: requiredEnv("AGENT_TASK_TOKEN"),
    taskSigningSecret: requiredEnv("AGENT_TASK_SIGNATURE_SECRET"),
    githubToken: requiredEnv("GITHUB_TOKEN"),
    githubRepository: requiredEnv("GITHUB_REPOSITORY"),
    githubBaseBranch: requiredEnv("GITHUB_BASE_BRANCH"),
    openRouterApiKey: requiredEnv("OPENROUTER_API_KEY"),
    openRouterBaseUrl: (process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    openRouterCodegenModel: requiredEnv("OPENROUTER_CODEGEN_MODEL"),
    sandboxCacheDir: process.env.SANDBOX_CACHE_DIR || path.join(os.tmpdir(), "discord-ai-agent-cache"),
    sandboxStartedAtMs: numberEnv("SANDBOX_STARTED_AT_MS")
  };
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in the sandbox environment.`);
  return value;
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function numberEnv(name: string) {
  const value = process.env[name];
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseGitHubRepository(repository: string) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY "${repository}". Expected owner/repo.`);
  return { owner, repo };
}
