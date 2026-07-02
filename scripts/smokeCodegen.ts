import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { loadConfig } from "../src/config/env.js";
import { resolveGitHubTaskToken } from "../src/github/appToken.js";
import { parseGitHubRepository } from "../src/github/repository.js";

type CallbackRecord = {
  path: string;
  body: Record<string, unknown>;
  at: string;
};

type SmokeArgs = {
  harness: "codex" | "opencode";
  model: string;
  title: string;
  request: string;
  closePr: boolean;
  timeoutMs: number;
  useBuiltRunner: boolean;
};

const args = parseArgs(process.argv.slice(2));

async function main() {
  const config = loadConfig();
  if (!config.openRouter.apiKey) throw new Error("OPENROUTER_API_KEY is required.");
  const githubToken = await resolveGitHubTaskToken(config);
  const taskId = `task-local-${args.harness}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sandboxRunId = `run-local-${randomUUID()}`;
  const taskToken = `local-smoke-${randomUUID()}`;
  const workDir = path.resolve(".discord-ai-agent", "codegen-smoke", taskId);
  const artifactDir = path.join(workDir, "artifacts");
  const cacheDir = path.resolve(".discord-ai-agent", "sandbox-cache");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const callbacks: CallbackRecord[] = [];
  let completion: Record<string, unknown> | undefined;
  let completeResolve: (() => void) | undefined;
  const completePromise = new Promise<void>((resolve) => {
    completeResolve = resolve;
  });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${taskToken}`) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJson(request);
      const at = new Date().toISOString();
      callbacks.push({ path: request.url ?? "/", body, at });
      process.stdout.write(`[callback] ${request.method} ${request.url}: ${summaryForCallback(body)}\n`);
      if (request.url?.includes("/artifacts")) {
        const safeName = safeFileName(`${String(body.kind ?? "artifact")}-${String(body.name ?? callbacks.length)}`);
        await fs.writeFile(path.join(artifactDir, `${callbacks.length}-${safeName}.txt`), String(body.content ?? ""), "utf8");
      }
      if (request.url?.endsWith("/complete")) {
        completion = body;
        completeResolve?.();
      }
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const controlPlaneInternalUrl = await listen(server);
  process.stdout.write(`local control plane: ${controlPlaneInternalUrl}\n`);
  process.stdout.write(`task id: ${taskId}\n`);
  process.stdout.write(`harness/model: ${args.harness} / ${args.model}\n`);
  process.stdout.write(`artifacts: ${artifactDir}\n`);

  const child = spawnRunner({
    env: {
      ...process.env,
      TASK_ID: taskId,
      TRACE_ID: taskId,
      SANDBOX_RUN_ID: sandboxRunId,
      TASK_TITLE: args.title,
      TASK_REQUEST: args.request,
      REQUESTED_BY: "local codegen smoke",
      CONTROL_PLANE_INTERNAL_URL: controlPlaneInternalUrl,
      AGENT_TASK_TOKEN: taskToken,
      GITHUB_TOKEN: githubToken,
      GITHUB_REPOSITORY: config.github.repository,
      GITHUB_BASE_BRANCH: config.github.baseBranch,
      OPENROUTER_API_KEY: config.openRouter.apiKey,
      OPENROUTER_CHAT_MODEL: config.openRouter.chatModel,
      OPENROUTER_CODEGEN_MODEL: args.model,
      CODEGEN_HARNESS: args.harness,
      SANDBOX_CACHE_DIR: cacheDir,
      SANDBOX_STARTED_AT_MS: String(Date.now()),
      NODE_ENV: "production"
    },
    useBuiltRunner: args.useBuiltRunner
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, args.timeoutMs);
  timeout.unref();

  const [exit] = await Promise.race([
    Promise.all([waitForExit(child), completePromise.then(() => undefined)]).then(([result]) => [result] as const),
    waitForExit(child).then((result) => [result] as const)
  ]);
  clearTimeout(timeout);
  server.close();

  await fs.writeFile(path.join(workDir, "callbacks.json"), JSON.stringify(callbacks, null, 2), "utf8");
  if (completion) await fs.writeFile(path.join(workDir, "completion.json"), JSON.stringify(completion, null, 2), "utf8");

  if (args.closePr && completion?.prUrl) {
    await closePullRequest({ configRepository: config.github.repository, token: githubToken, prUrl: String(completion.prUrl), branchName: nullableString(completion.branchName) });
  }

  if (exit.code !== 0 || !completion || completion.status !== "succeeded") {
    throw new Error(`Codegen smoke failed: exit=${exit.code} status=${String(completion?.status ?? "missing")}`);
  }

  process.stdout.write(`smoke ok: ${completion.prUrl}\n`);
  if (args.closePr) process.stdout.write("smoke cleanup: PR closed and branch delete attempted\n");
}

function spawnRunner(input: { env: NodeJS.ProcessEnv; useBuiltRunner: boolean }) {
  const command = process.execPath;
  const runnerArgs = input.useBuiltRunner
    ? ["dist/src/execution/sandboxRunner.js"]
    : [path.resolve("node_modules/tsx/dist/cli.mjs"), "src/execution/sandboxRunner.ts"];
  process.stdout.write(`$ ${command} ${runnerArgs.join(" ")}\n`);
  const child = spawn(command, runnerArgs, {
    cwd: process.cwd(),
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function listen(server: http.Server) {
  return new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to bind local control plane."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function readJson(request: http.IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : {});
    });
  });
}

function sendJson(response: http.ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function summaryForCallback(body: Record<string, unknown>) {
  return [body.status, body.step, body.message, body.name, body.prUrl].filter(Boolean).join(" | ") || "ok";
}

async function closePullRequest(input: { configRepository: string; token: string; prUrl: string; branchName?: string | null }) {
  const { owner, repo } = parseGitHubRepository(input.configRepository);
  const match = input.prUrl.match(/\/pull\/(\d+)(?:$|[/?#])/);
  if (!match) throw new Error(`Could not parse pull request URL: ${input.prUrl}`);
  const pullNumber = Number(match[1]);
  const octokit = new Octokit({ auth: input.token });
  await octokit.pulls.update({ owner, repo, pull_number: pullNumber, state: "closed" });
  process.stdout.write(`closed smoke PR: ${input.prUrl}\n`);
  if (input.branchName) {
    await octokit.git.deleteRef({ owner, repo, ref: `heads/${input.branchName}` }).catch((error) => {
      process.stderr.write(`failed to delete smoke branch ${input.branchName}: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}

function parseArgs(values: string[]): SmokeArgs {
  const harness = valueFor(values, "--harness") ?? "opencode";
  if (harness !== "codex" && harness !== "opencode") throw new Error("--harness must be codex or opencode");
  return {
    harness,
    model: valueFor(values, "--model") ?? process.env.OPENROUTER_CODEGEN_MODEL ?? process.env.OPENROUTER_CHAT_MODEL ?? "z-ai/glm-5.2",
    title: valueFor(values, "--title") ?? "Local codegen smoke test",
    request:
      valueFor(values, "--request") ??
      "Make a tiny README.md wording change for a temporary local codegen smoke test. Keep it to one sentence and do not modify behavior.",
    closePr: values.includes("--close-pr"),
    timeoutMs: Number(valueFor(values, "--timeout-ms") ?? 20 * 60_000),
    useBuiltRunner: values.includes("--built")
  };
}

function valueFor(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  return values[index + 1];
}

function safeFileName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "artifact";
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
