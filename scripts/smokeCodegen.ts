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
  requestFile?: string;
  suiteFile?: string;
  caseId?: string;
  closePr: boolean;
  timeoutMs: number;
  useBuiltRunner: boolean;
};

type SmokeSuiteCase = {
  id: string;
  title?: string;
  request?: string;
  requestFile?: string;
  harness?: "codex" | "opencode";
  model?: string;
  timeoutMs?: number;
  closePr?: boolean;
  skip?: boolean;
  skipReason?: string;
};

type SmokeSuite = {
  version: 1;
  name: string;
  cases: SmokeSuiteCase[];
};

type SmokeRunResult = {
  id?: string;
  title: string;
  harness: string;
  model: string;
  taskId?: string;
  status: string;
  durationMs: number;
  summaryPath?: string;
  workDir?: string;
  prUrl?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
};

async function main() {
  const args = await parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!config.openRouter.apiKey) throw new Error("OPENROUTER_API_KEY is required.");
  const githubToken = await resolveGitHubTaskToken(config);
  if (args.suiteFile) {
    const suite = await loadSmokeSuite(args.suiteFile);
    const result = await runSmokeSuite({ args, suite, config, githubToken });
    if (result.failed > 0) throw new Error(`Codegen smoke suite failed: ${result.failed}/${result.total} failed. See ${result.summaryPath}`);
    return;
  }

  const result = await runCodegenSmokeCase({ args, config, githubToken });
  if (result.status !== "succeeded") {
    throw new Error(`Codegen smoke failed: status=${result.status}. See ${result.summaryPath ?? result.workDir ?? "smoke output"}`);
  }
}

async function runCodegenSmokeCase(input: { args: SmokeArgs; config: ReturnType<typeof loadConfig>; githubToken: string }): Promise<SmokeRunResult> {
  const { args, config, githubToken } = input;
  const caseSlug = args.caseId ? `${safeFileName(args.caseId)}-` : "";
  const taskId = `task-local-${args.harness}-${caseSlug}${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sandboxRunId = `run-local-${randomUUID()}`;
  const taskToken = `local-smoke-${randomUUID()}`;
  const workDir = path.resolve(".discord-ai-agent", "codegen-smoke", taskId);
  const artifactDir = path.join(workDir, "artifacts");
  const cacheDir = path.resolve(".discord-ai-agent", "sandbox-cache");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const startedAt = Date.now();
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
  if (args.requestFile) process.stdout.write(`request file: ${args.requestFile}\n`);

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

  const summary = formatSmokeSummary({
    taskId,
    harness: args.harness,
    model: args.model,
    title: args.title,
    request: args.request,
    workDir,
    artifactDir,
    durationMs: Date.now() - startedAt,
    exit,
    callbacks,
    completion
  });
  const summaryPath = path.join(workDir, "summary.md");
  await fs.writeFile(summaryPath, summary, "utf8");
  process.stdout.write(`summary: ${summaryPath}\n`);
  const failureDiagnosis = failureDiagnosisLines(completion).join("\n");
  if (failureDiagnosis) process.stdout.write(`${failureDiagnosis}\n`);

  if (args.closePr && completion?.prUrl) {
    await closePullRequest({ configRepository: config.github.repository, token: githubToken, prUrl: String(completion.prUrl), branchName: nullableString(completion.branchName) });
  }

  const status = exit.code !== 0 || !completion ? terminalStatus(completion, exit) : String(completion.status ?? "unknown");
  if (status === "succeeded") {
    process.stdout.write(`smoke ok: ${completion?.prUrl}\n`);
    if (args.closePr) process.stdout.write("smoke cleanup: PR closed and branch delete attempted\n");
  }
  return {
    id: args.caseId,
    title: args.title,
    harness: args.harness,
    model: args.model,
    taskId,
    status,
    durationMs: Date.now() - startedAt,
    summaryPath,
    workDir,
    prUrl: typeof completion?.prUrl === "string" ? completion.prUrl : undefined,
    error: typeof completion?.error === "string" ? completion.error : undefined
  };
}

async function runSmokeSuite(input: { args: SmokeArgs; suite: SmokeSuite; config: ReturnType<typeof loadConfig>; githubToken: string }) {
  const suiteStartedAt = Date.now();
  const suiteDir = path.resolve(".discord-ai-agent", "codegen-smoke", "suites", `${safeFileName(input.suite.name)}-${suiteStartedAt}`);
  await fs.mkdir(suiteDir, { recursive: true });
  const results: SmokeRunResult[] = [];
  process.stdout.write(`suite: ${input.suite.name}\n`);
  process.stdout.write(`suite output: ${suiteDir}\n`);

  for (const testCase of input.suite.cases) {
    if (testCase.skip) {
      const skipped = skippedSuiteResult(testCase, input.args);
      results.push(skipped);
      process.stdout.write(`[suite] skipped ${testCase.id}: ${skipped.skipReason ?? "skip=true"}\n`);
      continue;
    }

    const caseArgs = await argsForSuiteCase(input.args, testCase, path.dirname(input.args.suiteFile!));
    process.stdout.write(`[suite] running ${testCase.id}: ${caseArgs.title}\n`);
    try {
      results.push(await runCodegenSmokeCase({ args: caseArgs, config: input.config, githubToken: input.githubToken }));
    } catch (error) {
      results.push({
        id: testCase.id,
        title: caseArgs.title,
        harness: caseArgs.harness,
        model: caseArgs.model,
        status: "error",
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const report = {
    suite: input.suite.name,
    suiteFile: input.args.suiteFile,
    startedAt: new Date(suiteStartedAt).toISOString(),
    durationMs: Date.now() - suiteStartedAt,
    total: results.filter((result) => !result.skipped).length,
    skipped: results.filter((result) => result.skipped).length,
    passed: results.filter((result) => result.status === "succeeded").length,
    failed: results.filter((result) => !result.skipped && result.status !== "succeeded").length,
    results
  };
  const resultsPath = path.join(suiteDir, "results.json");
  const summaryPath = path.join(suiteDir, "summary.md");
  await fs.writeFile(resultsPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(summaryPath, formatSmokeSuiteSummary(report), "utf8");
  process.stdout.write(`suite summary: ${summaryPath}\n`);
  return { ...report, resultsPath, summaryPath };
}

function skippedSuiteResult(testCase: SmokeSuiteCase, defaults: SmokeArgs): SmokeRunResult {
  return {
    id: testCase.id,
    title: testCase.title ?? testCase.id,
    harness: testCase.harness ?? defaults.harness,
    model: testCase.model ?? defaults.model,
    status: "skipped",
    durationMs: 0,
    skipped: true,
    skipReason: testCase.skipReason ?? "skip=true"
  };
}

async function argsForSuiteCase(defaults: SmokeArgs, testCase: SmokeSuiteCase, suiteDir: string): Promise<SmokeArgs> {
  const requestFile = testCase.requestFile ? path.resolve(suiteDir, testCase.requestFile) : undefined;
  if (!testCase.request && !requestFile) throw new Error(`Codegen smoke suite case ${testCase.id} must define request or requestFile.`);
  return {
    ...defaults,
    caseId: testCase.id,
    suiteFile: undefined,
    harness: testCase.harness ?? defaults.harness,
    model: testCase.model ?? defaults.model,
    title: testCase.title ?? testCase.id,
    request: requestFile ? await fs.readFile(requestFile, "utf8") : testCase.request!,
    requestFile,
    closePr: testCase.closePr ?? defaults.closePr,
    timeoutMs: testCase.timeoutMs ?? defaults.timeoutMs
  };
}

export function formatSmokeSuiteSummary(input: {
  suite: string;
  suiteFile?: string;
  startedAt: string;
  durationMs: number;
  total: number;
  skipped: number;
  passed: number;
  failed: number;
  results: SmokeRunResult[];
}) {
  const lines = [
    "# Codegen Smoke Suite",
    "",
    `Suite: ${input.suite}`,
    input.suiteFile ? `Suite file: ${input.suiteFile}` : undefined,
    `Started: ${input.startedAt}`,
    `Duration: ${formatDuration(input.durationMs)}`,
    `Passed: ${input.passed}/${input.total}`,
    `Failed: ${input.failed}`,
    `Skipped: ${input.skipped}`,
    "",
    "## Cases",
    ""
  ].filter((line): line is string => line !== undefined);
  for (const result of input.results) {
    lines.push(`- ${result.id ?? result.taskId ?? result.title}: ${result.status} (${result.harness} / ${result.model}, ${formatDuration(result.durationMs)})`);
    if (result.summaryPath) lines.push(`  Summary: ${result.summaryPath}`);
    if (result.prUrl) lines.push(`  PR: ${result.prUrl}`);
    if (result.error) lines.push(`  Error: ${result.error}`);
    if (result.skipped && result.skipReason) lines.push(`  Skip reason: ${result.skipReason}`);
  }
  return lines.join("\n");
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

export function formatSmokeSummary(input: {
  taskId: string;
  harness: string;
  model: string;
  title: string;
  request: string;
  workDir: string;
  artifactDir: string;
  durationMs: number;
  exit: { code: number | null; signal: NodeJS.Signals | null };
  callbacks: CallbackRecord[];
  completion?: Record<string, unknown>;
}) {
  const terminal = input.completion;
  const status = terminalStatus(input.completion, input.exit);
  const lines = [
    "# Codegen Smoke Summary",
    "",
    `Task: ${input.taskId}`,
    `Status: ${status}`,
    `Harness: ${input.harness}`,
    `Model: ${input.model}`,
    `Duration: ${formatDuration(input.durationMs)}`,
    `Exit: ${input.exit.code ?? "signal"}${input.exit.signal ? ` (${input.exit.signal})` : ""}`,
    `Work dir: ${input.workDir}`,
    `Artifacts: ${input.artifactDir}`,
    "",
    "## Request",
    "",
    `Title: ${input.title}`,
    "",
    input.request,
    "",
    "## Completion",
    ""
  ];
  if (!terminal) {
    lines.push("No completion callback was received.");
  } else {
    for (const key of ["status", "branchName", "prUrl", "error"]) {
      const value = terminal[key];
      if (value != null && value !== "") lines.push(`- ${key}: ${String(value)}`);
    }
    const diagnosis = failureDiagnosisLines(terminal);
    if (diagnosis.length > 0) {
      lines.push("", "## Failure Diagnosis", "", ...diagnosis.map((line) => `- ${line}`));
    }
  }
  lines.push("", "## Callback Timeline", "");
  if (input.callbacks.length === 0) {
    lines.push("No callbacks were received.");
  } else {
    for (const callback of input.callbacks) {
      lines.push(`- ${callback.at} ${callback.path}: ${summaryForCallback(callback.body)}`);
    }
  }
  return lines.join("\n");
}

function terminalStatus(completion: Record<string, unknown> | undefined, exit: { code: number | null; signal: NodeJS.Signals | null }) {
  if (completion?.status) return String(completion.status);
  if (exit.signal) return `terminated:${exit.signal}`;
  if (exit.code != null) return `exit:${exit.code}`;
  return "unknown";
}

function failureDiagnosisLines(completion: Record<string, unknown> | undefined) {
  const metadata = objectRecord(completion?.metadata);
  const diagnosis = objectRecord(metadata?.failureDiagnosis);
  if (!diagnosis) return [];
  const lines: string[] = [];
  for (const key of ["category", "summary", "nextAction", "failedPhase"]) {
    const value = diagnosis[key];
    if (typeof value === "string" && value.trim()) lines.push(`${key}: ${value.trim()}`);
  }
  const slowestPhase = objectRecord(diagnosis.slowestPhase);
  if (typeof slowestPhase?.name === "string" && typeof slowestPhase.durationMs === "number") {
    lines.push(`slowestPhase: ${slowestPhase.name} (${formatDuration(slowestPhase.durationMs)})`);
  }
  return lines;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

export async function loadSmokeSuite(suiteFile: string): Promise<SmokeSuite> {
  const suitePath = path.resolve(suiteFile);
  const raw = JSON.parse(await fs.readFile(suitePath, "utf8")) as unknown;
  const suite = objectRecord(raw);
  if (!suite) throw new Error(`Invalid codegen smoke suite ${suitePath}: expected JSON object.`);
  if (suite.version !== 1) throw new Error(`Invalid codegen smoke suite ${suitePath}: version must be 1.`);
  if (typeof suite.name !== "string" || !suite.name.trim()) throw new Error(`Invalid codegen smoke suite ${suitePath}: name is required.`);
  if (!Array.isArray(suite.cases)) throw new Error(`Invalid codegen smoke suite ${suitePath}: cases must be an array.`);
  return {
    version: 1,
    name: suite.name.trim(),
    cases: suite.cases.map((value, index) => normalizeSmokeSuiteCase(value, index, suitePath))
  };
}

function normalizeSmokeSuiteCase(value: unknown, index: number, suitePath: string): SmokeSuiteCase {
  const item = objectRecord(value);
  if (!item) throw new Error(`Invalid codegen smoke suite ${suitePath}: cases[${index}] must be an object.`);
  const id = stringField(item, "id") ?? `case-${index + 1}`;
  const harness = stringField(item, "harness");
  if (harness && harness !== "codex" && harness !== "opencode") {
    throw new Error(`Invalid codegen smoke suite ${suitePath}: cases[${index}].harness must be codex or opencode.`);
  }
  const timeoutMs = numberField(item, "timeoutMs");
  return {
    id,
    title: stringField(item, "title"),
    request: stringField(item, "request"),
    requestFile: stringField(item, "requestFile"),
    harness: harness as SmokeSuiteCase["harness"],
    model: stringField(item, "model"),
    timeoutMs,
    closePr: booleanField(item, "closePr"),
    skip: booleanField(item, "skip"),
    skipReason: stringField(item, "skipReason")
  };
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function numberField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function booleanField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

export async function parseArgs(values: string[]): Promise<SmokeArgs> {
  const harness = valueFor(values, "--harness") ?? "opencode";
  if (harness !== "codex" && harness !== "opencode") throw new Error("--harness must be codex or opencode");
  const suiteFile = valueFor(values, "--suite");
  const requestFile = valueFor(values, "--request-file");
  const request = requestFile
    ? await fs.readFile(path.resolve(requestFile), "utf8")
    : valueFor(values, "--request") ??
      "Make a tiny README.md wording change for a temporary local codegen smoke test. Keep it to one sentence and do not modify behavior.";
  return {
    harness,
    model: valueFor(values, "--model") ?? process.env.OPENROUTER_CODEGEN_MODEL ?? process.env.OPENROUTER_CHAT_MODEL ?? "z-ai/glm-5.2",
    title: valueFor(values, "--title") ?? "Local codegen smoke test",
    request,
    requestFile: requestFile ? path.resolve(requestFile) : undefined,
    suiteFile: suiteFile ? path.resolve(suiteFile) : undefined,
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

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
