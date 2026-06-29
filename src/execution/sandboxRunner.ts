import { randomUUID } from "node:crypto";
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
};

async function main() {
  const env = loadSandboxEnv();
  try {
    const result = await runCodeUpdate(env);
    await complete(env, {
      status: "succeeded",
      branchName: result.branchName,
      prUrl: result.prUrl,
      draft: result.draft,
      verifyPassed: result.verifyPassed
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await complete(env, {
      status: message.includes("produced no diff") ? "no_changes" : "failed",
      error: message
    }).catch((callbackError) => {
      console.error("Failed to post terminal task callback", callbackError);
    });
    throw error;
  }
}

async function runCodeUpdate(env: SandboxEnv) {
  const { owner, repo } = parseGitHubRepository(env.githubRepository);
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-ai-agent-sandbox-"));
  const checkoutDir = path.join(workRoot, "repo");
  const branchName = codeUpdateBranchName(env.taskTitle);
  const gitEnv = await gitAuthEnv(env.githubToken, workRoot);

  try {
    await progress(env, "clone", "Cloning the repository into the sandbox.", { branch: env.githubBaseBranch });
    await runCommand("git", ["clone", "--depth", "1", "--branch", env.githubBaseBranch, `https://github.com/${owner}/${repo}.git`, checkoutDir], {
      cwd: workRoot,
      env: gitEnv
    });
    await progress(env, "branch", `Creating implementation branch ${branchName}.`, { branchName });
    await runCommand("git", ["checkout", "-b", branchName], { cwd: checkoutDir });
    await progress(env, "install", "Installing repository dependencies with npm ci.");
    await runCommand("npm", ["ci"], { cwd: checkoutDir });
    await progress(env, "configure", "Writing ephemeral Codex configuration.");
    await writeCodexConfig(workRoot, checkoutDir, env);

    await progress(env, "codex", "Running Codex to implement the requested change.", { model: env.openRouterChatModel });
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
        input: codeUpdatePrompt(env)
      }
    );

    await progress(env, "diff", "Checking whether Codex produced a real code diff.");
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: checkoutDir });
    if (!status.stdout.trim()) {
      throw new Error("Agent task produced no diff; no PR will be opened.");
    }

    await progress(env, "verify", "Running npm run verify on the generated changes.");
    const verify = await runCommand("npm", ["run", "verify"], { cwd: checkoutDir, allowFailure: true });
    await progress(env, "scan", "Running release scan before pushing generated changes.");
    const scan = await runCommand("npm", ["run", "scan:release"], { cwd: checkoutDir, allowFailure: true });
    if (scan.exitCode !== 0) {
      throw new Error("Release scan failed after agent task; refusing to push generated changes.");
    }

    await progress(env, "commit", "Committing generated changes.");
    await runCommand("git", ["config", "user.name", "discord-ai-agent"], { cwd: checkoutDir });
    await runCommand("git", ["config", "user.email", "discord-ai-agent-bot@users.noreply.github.com"], { cwd: checkoutDir });
    await runCommand("git", ["add", "-A"], { cwd: checkoutDir });
    await runCommand("git", ["commit", "-m", `Implement Discord AI Agent update: ${env.taskTitle}`], { cwd: checkoutDir });
    await progress(env, "push", "Pushing the generated branch to GitHub.", { branchName });
    await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: checkoutDir, env: gitEnv });

    const draft = verify.exitCode !== 0;
    await progress(env, "pr", "Opening the GitHub pull request.", { draft });
    const pr = await new Octokit({ auth: env.githubToken }).pulls.create({
      owner,
      repo,
      title: `Update Discord AI Agent: ${env.taskTitle}`,
      head: branchName,
      base: env.githubBaseBranch,
      draft,
      body: pullRequestBody({ env, verifyPassed: verify.exitCode === 0 })
    });

    return {
      branchName,
      prUrl: pr.data.html_url,
      draft,
      verifyPassed: verify.exitCode === 0
    };
  } finally {
    await progress(env, "cleanup", "Cleaning up the ephemeral sandbox checkout.").catch(() => undefined);
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
    openRouterChatModel: requiredEnv("OPENROUTER_CHAT_MODEL")
  };
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in the sandbox environment.`);
  return value;
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

function pullRequestBody(input: { env: SandboxEnv; verifyPassed: boolean }) {
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
  console.log(JSON.stringify({ event: "sandbox.command.start", command, args: redactedArgs(command, args), cwd: options.cwd }));
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
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = appendLimited(stderr, text);
    process.stderr.write(text);
  });

  if (options.input) child.stdin.write(options.input);
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}: ${stderr || stdout}`);
  }
  return { exitCode, stdout, stderr };
}

function appendLimited(current: string, next: string) {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURED_COMMAND_OUTPUT) return combined;
  return combined.slice(combined.length - MAX_CAPTURED_COMMAND_OUTPUT);
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
