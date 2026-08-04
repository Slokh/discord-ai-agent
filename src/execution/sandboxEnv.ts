import os from "node:os";
import path from "node:path";
import { productConfig } from "../config/env.js";
import type { SandboxEnv } from "./types.js";

export type { SandboxEnv, TaskTimings } from "./types.js";

export function loadSandboxEnv(): SandboxEnv {
  const taskId = requiredEnv("TASK_ID");
  const taskType = process.env.TASK_TYPE === "bug_report"
    ? "bug_report"
    : process.env.TASK_TYPE === "diagnosis"
      ? "diagnosis"
      : "code_update";
  return {
    taskType,
    taskId,
    traceId: requiredEnv("TRACE_ID"),
    sandboxRunId: requiredEnv("SANDBOX_RUN_ID"),
    taskTitle: requiredEnv("TASK_TITLE"),
    taskRequest: requiredEnv("TASK_REQUEST"),
    bugReportResultPath: path.join(os.tmpdir(), `${taskId}-bug-report-result.json`),
    requestedBy: requiredEnv("REQUESTED_BY"),
    targetBranch: optionalEnv("TARGET_BRANCH"),
    targetPullRequestNumber: numberEnv("TARGET_PULL_REQUEST_NUMBER"),
    targetPullRequestUrl: optionalEnv("TARGET_PULL_REQUEST_URL"),
    controlPlaneInternalUrl: argumentValue("--control-url") ?? productConfig.control.internalUrl,
    taskToken: requiredEnv("AGENT_TASK_TOKEN"),
    taskCallbackSecret: requiredEnv("AGENT_TASK_CALLBACK_SECRET"),
    githubToken: requiredEnv("GITHUB_TOKEN"),
    githubRepository: productConfig.github.repository,
    githubBaseBranch: productConfig.github.baseBranch,
    openRouterApiKey: requiredEnv("OPENROUTER_API_KEY"),
    openRouterBaseUrl: productConfig.models.baseUrl,
    openRouterCodegenModel: argumentValue("--model") ?? productConfig.models.codegen,
    sandboxCacheDir: argumentValue("--cache-dir") ?? path.join(os.tmpdir(), "discord-ai-agent-cache"),
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

function argumentValue(name: string) {
  const prefix = `${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim();
  return value || null;
}
