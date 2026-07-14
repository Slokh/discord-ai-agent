import os from "node:os";
import path from "node:path";
import type { CodegenHarness } from "./harness/types.js";

export type SandboxEnv = {
  taskId: string;
  traceId: string;
  sandboxRunId: string;
  taskTitle: string;
  taskRequest: string;
  requestedBy: string;
  targetBranch: string | null;
  targetPullRequestNumber: number | null;
  targetPullRequestUrl: string | null;
  controlPlaneInternalUrl: string;
  taskToken: string;
  taskSigningSecret: string;
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

export type TaskTimings = Record<string, number>;

export function loadSandboxEnv(): SandboxEnv {
  return {
    taskId: requiredEnv("TASK_ID"),
    traceId: requiredEnv("TRACE_ID"),
    sandboxRunId: requiredEnv("SANDBOX_RUN_ID"),
    taskTitle: requiredEnv("TASK_TITLE"),
    taskRequest: requiredEnv("TASK_REQUEST"),
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

export function codegenHarnessFromEnv(value: string | undefined): CodegenHarness {
  if (!value || value === "codex") return "codex";
  if (value === "opencode") return "opencode";
  throw new Error(`Invalid CODEGEN_HARNESS "${value}". Expected "codex" or "opencode".`);
}

export function codegenHarnessDisplayName(harness: CodegenHarness) {
  return harness === "opencode" ? "OpenCode" : "Codex";
}

export function parseGitHubRepository(repository: string) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY "${repository}". Expected owner/repo.`);
  return { owner, repo };
}
