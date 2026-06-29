import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../config/env.js";
import { parseGitHubRepository } from "../skills/github.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { slugify } from "../util/text.js";

const MAX_CAPTURED_COMMAND_OUTPUT = 40_000;

export type AgentCodegenJob = {
  requestId: string;
  request: string;
  updateName: string;
  requestedBy: string;
  traceId?: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
};

export type AgentCodegenResult = {
  branchName: string;
  prUrl: string;
  draft: boolean;
  verifyPassed: boolean;
};

export async function runAgentCodegenJob(input: { config: AppConfig; job: AgentCodegenJob }): Promise<AgentCodegenResult> {
  const { config, job } = input;
  if (!config.github.token) {
    throw new Error("GITHUB_TOKEN is required for Railway-native agent codegen.");
  }
  if (!config.openRouter.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for Railway-native agent codegen.");
  }

  const { owner, repo } = parseGitHubRepository(config.github.repository);
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-ai-agent-codegen-"));
  const checkoutDir = path.join(workRoot, "repo");
  const branchName = codegenBranchName(job.updateName);
  const authEnv = await gitAuthEnv(workRoot, config.github.token);
  const startedAt = Date.now();

  logger.info(
    { requestId: job.requestId, updateName: job.updateName, requestedBy: job.requestedBy, branchName },
    "Starting Railway-native agent codegen job"
  );

  try {
    await runCommand("git", ["clone", "--depth", "1", "--branch", config.github.baseBranch, `https://github.com/${owner}/${repo}.git`, checkoutDir], {
      cwd: workRoot,
      env: authEnv
    });
    await runCommand("git", ["checkout", "-b", branchName], { cwd: checkoutDir });
    await runCommand("npm", ["ci"], { cwd: checkoutDir });
    await writeCodexConfig(workRoot, checkoutDir, config);

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
        config.openRouter.chatModel,
        "-"
      ],
      {
        cwd: checkoutDir,
        env: {
          ...authEnv,
          CODEX_HOME: path.join(workRoot, ".codex"),
          OPENROUTER_API_KEY: config.openRouter.apiKey,
          npm_config_yes: "true"
        },
        input: codegenPrompt(job)
      }
    );

    const status = await runCommand("git", ["status", "--porcelain"], { cwd: checkoutDir });
    if (!status.stdout.trim()) {
      throw new Error("Agent codegen produced no diff; no PR will be opened.");
    }

    const verify = await runCommand("npm", ["run", "verify"], { cwd: checkoutDir, allowFailure: true });
    const scan = await runCommand("npm", ["run", "scan:release"], { cwd: checkoutDir, allowFailure: true });
    if (scan.exitCode !== 0) {
      throw new Error("Release scan failed after agent codegen; refusing to push generated changes.");
    }

    await runCommand("git", ["config", "user.name", "discord-ai-agent"], { cwd: checkoutDir });
    await runCommand("git", ["config", "user.email", "discord-ai-agent-bot@users.noreply.github.com"], { cwd: checkoutDir });
    await runCommand("git", ["add", "-A"], { cwd: checkoutDir });
    await runCommand("git", ["commit", "-m", `Implement Discord AI Agent update: ${job.updateName}`], { cwd: checkoutDir });
    await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: checkoutDir, env: authEnv });

    const draft = verify.exitCode !== 0;
    const pr = await new Octokit({ auth: config.github.token }).pulls.create({
      owner,
      repo,
      title: `Update Discord AI Agent: ${job.updateName}`,
      head: branchName,
      base: config.github.baseBranch,
      draft,
      body: pullRequestBody({
        job,
        model: config.openRouter.chatModel,
        verifyPassed: verify.exitCode === 0
      })
    });

    logger.info(
      { requestId: job.requestId, branchName, prUrl: pr.data.html_url, draft, durationMs: durationMs(startedAt) },
      "Railway-native agent codegen PR opened"
    );
    return {
      branchName,
      prUrl: pr.data.html_url,
      draft,
      verifyPassed: verify.exitCode === 0
    };
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function codegenBranchName(updateName: string) {
  const slug = slugify(updateName).slice(0, 48) || "agent-update";
  return `discord-ai-agent/update-${slug}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function gitAuthEnv(workRoot: string, token: string) {
  const askPassPath = path.join(workRoot, "git-askpass.sh");
  await fs.writeFile(
    askPassPath,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) printf '%s\\n' x-access-token ;;",
      "  *) printf '%s\\n' \"$GIT_TOKEN\" ;;",
      "esac",
      ""
    ].join("\n"),
    { mode: 0o700 }
  );
  return {
    ...process.env,
    GIT_ASKPASS: askPassPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_TOKEN: token
  };
}

async function writeCodexConfig(workRoot: string, checkoutDir: string, config: AppConfig) {
  const codexHome = path.join(workRoot, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model = ${JSON.stringify(config.openRouter.chatModel)}`,
      'model_provider = "openrouter"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
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

function codegenPrompt(job: AgentCodegenJob) {
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
    `Request ID: ${job.requestId}`,
    `Requested by: ${job.requestedBy}`,
    "",
    "Requested update:",
    job.request.trim(),
    ""
  ].join("\n");
}

function pullRequestBody(input: { job: AgentCodegenJob; model: string; verifyPassed: boolean }) {
  return [
    `Prompted by: ${input.job.requestedBy}`,
    "",
    "## Requested Update",
    "",
    input.job.request.trim(),
    "",
    "## Agent Codegen",
    "",
    `- Request ID: \`${input.job.requestId}\``,
    "- Runtime: Railway `codegen` worker",
    `- Model: \`${input.model}\``,
    "",
    "## Verification",
    "",
    `- \`npm run verify\`: ${input.verifyPassed ? "passed" : "failed; opened as draft"}`,
    "- `npm run scan:release`: passed"
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
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const startedAt = Date.now();
  logger.info({ command, args: redactedArgs(command, args), cwd: options.cwd }, "Starting codegen command");

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout = appendLimited(stdout, text);
    logCommandOutput(command, "stdout", text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = appendLimited(stderr, text);
    logCommandOutput(command, "stderr", text);
  });

  if (options.input) child.stdin.end(options.input);
  else child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  logger.info({ command, exitCode, durationMs: durationMs(startedAt) }, "Codegen command finished");

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}: ${previewText(stderr || stdout, 1000)}`);
  }
  return { exitCode, stdout, stderr };
}

function appendLimited(current: string, next: string) {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURED_COMMAND_OUTPUT) return combined;
  return combined.slice(combined.length - MAX_CAPTURED_COMMAND_OUTPUT);
}

function logCommandOutput(command: string, stream: "stdout" | "stderr", text: string) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    logger.info({ command, stream, line: previewText(line, 1000) }, "Codegen command output");
  }
}

function redactedArgs(command: string, args: string[]) {
  if (command === "git" && args[0] === "clone") {
    return args.map((arg) => (arg.startsWith("https://github.com/") ? "https://github.com/[repo].git" : arg));
  }
  return args;
}
