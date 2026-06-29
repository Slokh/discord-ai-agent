import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../config/env.js";
import { parseGitHubRepository } from "../skills/github.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { slugify } from "../util/text.js";
import { CodexActivityTracker, type CodexActivitySnapshot, type CodexCommandEvent } from "./activity.js";
import { AppConfigCodegenCredentialProvider, type CodegenCredentialProvider } from "./credentials.js";
import { reportCodegenProgress, type CodegenProgressEvent, type CodegenProgressReporter } from "./progress.js";

const MAX_CAPTURED_COMMAND_OUTPUT = 40_000;
const CODEX_OUTPUT_LOG_INTERVAL_MS = 30_000;
const CODEX_ACTIVITY_HEARTBEAT_MS = 5_000;
const CODEX_TERMINATION_GRACE_MS = 10_000;
export const CODEGEN_WORK_ROOT_DIR = ".codegen-runs";
export const CODEGEN_COMMAND_WARNING_THRESHOLD = 35;
export const CODEGEN_PROMPT_COMMAND_BUDGET = 35;
export const CODEGEN_REQUIRED_DEV_TOOLS = ["tsx", "tsc", "eslint", "vitest"] as const;
export const CODEGEN_REPO_CONTEXT_MAP = [
  "Repository navigation map:",
  "- Discord intake, mention handling, reply editing, reply-chain context, and conversation memory writes: src/discord/client.ts.",
  "- Discord crawling, message persistence, permission checks, and command cleanup: src/discord/crawler.ts, src/discord/messagePersistence.ts, src/discord/permissions.ts, src/discord/registerCommands.ts.",
  "- Agent loop, model prompts, hosted/local tool execution, final response synthesis, and conversation memory shaping: src/agent/router.ts.",
  "- Tool schemas and tool routing guidance: src/tools/registry.ts. Tool implementations live in src/tools/coreTools.ts. Shared tool context types live in src/tools/types.ts.",
  "- Discord history search, embeddings, normalization, and retrieval behavior: src/memory/search.ts, src/memory/embedding.ts, src/memory/normalize.ts, plus query methods in src/db/repositories.ts.",
  "- Database schema and persistence methods: migrations/*.sql and src/db/repositories.ts.",
  "- OpenRouter chat, embeddings, images, hosted tools, timeouts, and response parsing: src/models/openrouter.ts.",
  "- Config and environment defaults: src/config/env.ts and .env.example.",
  "- Background queues and workers for crawling, embeddings, and codegen: src/jobs/queue.ts and src/index.ts.",
  "- Railway-native self-update/codegen flow: src/codegen/backend.ts, src/codegen/runner.ts, src/codegen/credentials.ts, src/codegen/progress.ts.",
  "- CLI scripts for local prompting, crawling, embeddings, deploy checks, and smoke tests: scripts/*.ts.",
  "- Unit tests are under tests/unit/*.test.ts; database-backed integration tests are under tests/integration/*.test.ts.",
  "- Ignore dist/ and node_modules/ when understanding source behavior; they are generated or installed artifacts."
].join("\n");

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

export async function runAgentCodegenJob(input: {
  config: AppConfig;
  job: AgentCodegenJob;
  credentials?: CodegenCredentialProvider;
  progress?: CodegenProgressReporter;
}): Promise<AgentCodegenResult> {
  const { config, job } = input;
  const credentials = input.credentials ?? new AppConfigCodegenCredentialProvider(config);
  credentials.assertAvailable();

  const { owner, repo } = parseGitHubRepository(config.github.repository);
  const workRoot = await createCodegenWorkRoot();
  const checkoutDir = path.join(workRoot, "repo");
  const branchName = codegenBranchName(job.updateName);
  const authEnv = await credentials.gitAuthEnv(workRoot);
  const commandEnv = codegenCommandEnv(authEnv);
  const startedAt = Date.now();

  logger.info(
    { requestId: job.requestId, updateName: job.updateName, requestedBy: job.requestedBy, branchName },
    "Starting Railway-native agent codegen job"
  );

  try {
    await progress(input.progress, "clone", "Cloning the repository into the Railway codegen worker.", { branch: config.github.baseBranch });
    await runCommand("git", ["clone", "--depth", "1", "--branch", config.github.baseBranch, `https://github.com/${owner}/${repo}.git`, checkoutDir], {
      cwd: workRoot,
      env: authEnv
    });
    await progress(input.progress, "branch", `Creating implementation branch ${branchName}.`, { branchName });
    await runCommand("git", ["checkout", "-b", branchName], { cwd: checkoutDir });
    await progress(input.progress, "install", "Installing repository dependencies with npm ci.");
    await runCommand("npm", ["ci", "--include=dev"], { cwd: checkoutDir, env: commandEnv });
    await progress(input.progress, "preflight", "Checking that codegen dev tooling is available.");
    await assertCodegenDevTooling(checkoutDir, commandEnv);
    await progress(input.progress, "configure", "Writing ephemeral Codex configuration.");
    await writeCodexConfig(workRoot, checkoutDir, config);

    const codegenModel = config.openRouter.codegenModel;
    const codexTimeoutMs = minutesToMs(config.codegenCodexTimeoutMinutes);
    let commandBudgetWarningReported = false;
    const pendingCodexProgressReports: Promise<void>[] = [];
    const queueCodexProgressReport = (promise: Promise<void>, failureMessage: string) => {
      pendingCodexProgressReports.push(promise.catch((error) => logger.warn({ err: error, requestId: job.requestId }, failureMessage)));
    };
    const codexActivity = new CodexActivityTracker({
      onCommand: (event) => {
        queueCodexProgressReport(
          progress(input.progress, "codex.command", codegenCommandProgressMessage(event), commandEventMetadata(event), {
            eventName: "codegen.command",
            level: event.status === "failed" ? "warn" : "debug",
            durationMs: event.durationMs ?? null,
            updateJobStatus: false
          }),
          "Failed to report Codex command event"
        );
      },
      onSnapshot: (snapshot) => {
        logCodexActivitySnapshot(job, snapshot);
        if (!snapshot.final && !commandBudgetWarningReported && snapshot.commandStarts >= CODEGEN_COMMAND_WARNING_THRESHOLD) {
          commandBudgetWarningReported = true;
          queueCodexProgressReport(
            progress(
              input.progress,
              "codex",
              `Codex has run ${snapshot.commandStarts} commands, which is above the ${CODEGEN_COMMAND_WARNING_THRESHOLD}-command soft budget.`,
              {
                activity: codexActivityMetadata(snapshot),
                commandBudget: {
                  warningThreshold: CODEGEN_COMMAND_WARNING_THRESHOLD,
                  promptBudget: CODEGEN_PROMPT_COMMAND_BUDGET
                }
              },
              {
                eventName: "codegen.warning",
                level: "warn"
              }
            ),
            "Failed to report Codex command budget warning"
          );
        }
        if (!snapshot.final) {
          queueCodexProgressReport(
            progress(input.progress, "codex", codexActivityProgressMessage(snapshot), {
              activity: codexActivityMetadata(snapshot)
            }),
            "Failed to report Codex activity progress"
          );
        }
      }
    });
    await progress(input.progress, "codex", "Running Codex to implement the requested change.", {
      model: codegenModel,
      timeoutMinutes: config.codegenCodexTimeoutMinutes
    });
    await runCommand(
      process.env.CODEX_BIN || "codex",
      codexExecArgs({ checkoutDir, model: codegenModel }),
      {
        cwd: checkoutDir,
        env: credentials.codexEnv({ baseEnv: commandEnv, workRoot }),
        input: codegenPrompt(job),
        timeoutMs: codexTimeoutMs,
        outputObserver: {
          onStdout: (text) => codexActivity.acceptStdout(text),
          onStderr: (text) => codexActivity.acceptStderr(text),
          onHeartbeat: () => codexActivity.heartbeat(),
          onFinish: () => codexActivity.finish(),
          heartbeatMs: CODEX_ACTIVITY_HEARTBEAT_MS
        }
      }
    );
    await Promise.allSettled(pendingCodexProgressReports);

    await progress(input.progress, "diff", "Checking whether Codex produced a real code diff.");
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: checkoutDir });
    if (!status.stdout.trim()) {
      throw new Error("Agent codegen produced no diff; no PR will be opened.");
    }

    await progress(input.progress, "verify", "Running npm run verify on the generated changes.");
    const verify = await runCommand("npm", ["run", "verify"], { cwd: checkoutDir, env: commandEnv, allowFailure: true });
    await progress(input.progress, "scan", "Running release scan before pushing generated changes.");
    const scan = await runCommand("npm", ["run", "scan:release"], { cwd: checkoutDir, env: commandEnv, allowFailure: true });
    if (scan.exitCode !== 0) {
      throw new Error("Release scan failed after agent codegen; refusing to push generated changes.");
    }

    await progress(input.progress, "commit", "Committing generated changes.");
    await runCommand("git", ["config", "user.name", "discord-ai-agent"], { cwd: checkoutDir });
    await runCommand("git", ["config", "user.email", "discord-ai-agent-bot@users.noreply.github.com"], { cwd: checkoutDir });
    await runCommand("git", ["add", "-A"], { cwd: checkoutDir });
    await runCommand("git", ["commit", "-m", `Implement Discord AI Agent update: ${job.updateName}`], { cwd: checkoutDir });
    await progress(input.progress, "push", "Pushing the generated branch to GitHub.", { branchName });
    await runCommand("git", ["push", "origin", `HEAD:${branchName}`], { cwd: checkoutDir, env: authEnv });

    const draft = verify.exitCode !== 0;
    await progress(input.progress, "pr", "Opening the GitHub pull request.", { draft });
    const pr = await new Octokit({ auth: credentials.githubToken() }).pulls.create({
      owner,
      repo,
      title: `Update Discord AI Agent: ${job.updateName}`,
      head: branchName,
      base: config.github.baseBranch,
      draft,
      body: pullRequestBody({
        job,
        model: codegenModel,
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
    await progress(input.progress, "cleanup", "Cleaning up the ephemeral codegen checkout.");
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createCodegenWorkRoot() {
  const root = path.resolve(process.cwd(), CODEGEN_WORK_ROOT_DIR);
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "discord-ai-agent-codegen-"));
}

function codegenBranchName(updateName: string) {
  const slug = slugify(updateName).slice(0, 48) || "agent-update";
  return `discord-ai-agent/update-${slug}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function codegenCommandEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    NODE_ENV: "development",
    NPM_CONFIG_INCLUDE: "dev",
    NPM_CONFIG_OMIT: "",
    NPM_CONFIG_PRODUCTION: "false",
    npm_config_include: "dev",
    npm_config_omit: "",
    npm_config_production: "false"
  };
}

export function codexExecArgs(input: { checkoutDir: string; model: string }) {
  return [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "-C",
    input.checkoutDir,
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    input.model,
    "-"
  ];
}

export async function missingCodegenDevTools(checkoutDir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const tool of CODEGEN_REQUIRED_DEV_TOOLS) {
    const binaryPath = codegenDevToolPath(checkoutDir, tool);
    try {
      await fs.access(binaryPath);
    } catch {
      missing.push(tool);
    }
  }
  return missing;
}

async function assertCodegenDevTooling(checkoutDir: string, env: NodeJS.ProcessEnv) {
  const missing = await missingCodegenDevTools(checkoutDir);
  if (missing.length > 0) {
    throw new Error(
      [
        `Codegen checkout is missing dev tool binaries after npm ci --include=dev: ${missing.join(", ")}.`,
        "The Railway codegen worker needs devDependencies in its ephemeral checkout before Codex can safely edit and verify changes."
      ].join(" ")
    );
  }

  for (const tool of CODEGEN_REQUIRED_DEV_TOOLS) {
    await runCommand(codegenDevToolPath(checkoutDir, tool), ["--version"], { cwd: checkoutDir, env });
  }
}

function codegenDevToolPath(checkoutDir: string, tool: (typeof CODEGEN_REQUIRED_DEV_TOOLS)[number]) {
  const binaryName = process.platform === "win32" ? `${tool}.cmd` : tool;
  return path.join(checkoutDir, "node_modules", ".bin", binaryName);
}

async function writeCodexConfig(workRoot: string, checkoutDir: string, config: AppConfig) {
  const codexHome = path.join(workRoot, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model = ${JSON.stringify(config.openRouter.codegenModel)}`,
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

export function codegenPrompt(job: AgentCodegenJob) {
  return [
    "You are implementing a Discord-requested update to this TypeScript Discord AI Agent repository.",
    "",
    "Requirements:",
    "- Read only the code that is relevant to the request before editing.",
    "- Use the repository map below to choose the first files to inspect; broaden with search only when the map does not cover the request.",
    "- Implement the requested behavior with a real code diff.",
    "- Keep changes focused and consistent with the existing architecture.",
    "- Add or update tests for the changed behavior.",
    "- Do not commit, push, open a PR, or edit GitHub state yourself.",
    "- Do not add request-only documentation artifacts; the PR body records the request.",
    "- Do not print full files or full diffs unless a command failure makes that necessary.",
    "- Use apply_patch for manual source edits. Do not use Python or Node string-rewrite scripts unless apply_patch is unavailable after one direct attempt.",
    "- Do not repeatedly reprint the same diff or revisit the same design choice once it is resolved.",
    "- Emit concise operational progress notes as you work: current action, important decision or blocker, and next step. Keep them factual and do not expose private chain-of-thought.",
    `- Target fewer than 25 shell commands. If you reach about ${CODEGEN_PROMPT_COMMAND_BUDGET} commands, stop broad exploration, make the smallest safe finish, run one focused check, and exit.`,
    "- Prefer one implementation pass, one focused typecheck/test pass, and at most one repair pass for failures.",
    "- Do not run full `npm test`, broad `vitest run tests/unit/`, `npm run verify`, or `npm audit`; the harness runs full verification after you exit.",
    "- Before finishing, run only the most relevant targeted tests plus `npm run typecheck` when useful, then exit promptly.",
    "",
    CODEGEN_REPO_CONTEXT_MAP,
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

function codegenCommandProgressMessage(event: CodexCommandEvent) {
  const duration = event.durationMs == null ? "" : ` in ${formatDuration(event.durationMs)}`;
  const exitCode = event.exitCode == null ? "" : ` (exit ${event.exitCode})`;
  return `Codex command ${event.status}${duration}${exitCode}: ${event.command}`;
}

function commandEventMetadata(event: CodexCommandEvent) {
  return {
    commandId: event.commandId,
    eventType: event.eventType,
    command: event.command,
    status: event.status,
    durationMs: event.durationMs,
    exitCode: event.exitCode,
    outputPreview: event.outputPreview
  };
}

async function progress(
  reporter: CodegenProgressReporter | undefined,
  step: string,
  message: string,
  metadata: Record<string, unknown> = {},
  options: Pick<CodegenProgressEvent, "eventName" | "level" | "durationMs" | "updateJobStatus"> = {}
) {
  const level = options.level ?? "info";
  logger[level]({ step, eventName: options.eventName, durationMs: options.durationMs, updateJobStatus: options.updateJobStatus, ...metadata }, `Codegen progress: ${message}`);
  await reportCodegenProgress(reporter, {
    step,
    message,
    metadata,
    eventName: options.eventName,
    level: options.level,
    durationMs: options.durationMs,
    updateJobStatus: options.updateJobStatus
  });
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    allowFailure?: boolean;
    timeoutMs?: number;
    outputObserver?: CommandOutputObserver;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const startedAt = Date.now();
  logger.info({ command, args: redactedArgs(command, args), cwd: options.cwd, timeoutMs: options.timeoutMs }, "Starting codegen command");

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const stdoutLogger = createCommandOutputLogger(command, "stdout");
  const stderrLogger = createCommandOutputLogger(command, "stderr");
  let timeout: NodeJS.Timeout | undefined;
  let forceKillTimeout: NodeJS.Timeout | undefined;
  let heartbeatInterval: NodeJS.Timeout | undefined;

  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      logger.error(
        { command, args: redactedArgs(command, args), timeoutMs: options.timeoutMs, durationMs: durationMs(startedAt) },
        "Codegen command timed out; terminating child process"
      );
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        logger.error({ command, args: redactedArgs(command, args) }, "Codegen command did not exit after SIGTERM; killing child process");
        child.kill("SIGKILL");
      }, CODEX_TERMINATION_GRACE_MS);
      forceKillTimeout.unref();
    }, options.timeoutMs);
    timeout.unref();
  }

  if (options.outputObserver?.onHeartbeat) {
    heartbeatInterval = setInterval(options.outputObserver.onHeartbeat, options.outputObserver.heartbeatMs ?? CODEX_OUTPUT_LOG_INTERVAL_MS);
    heartbeatInterval.unref();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout = appendLimited(stdout, text);
    options.outputObserver?.onStdout?.(text);
    logCommandOutput(stdoutLogger, text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = appendLimited(stderr, text);
    options.outputObserver?.onStderr?.(text);
    logCommandOutput(stderrLogger, text);
  });

  if (options.input) child.stdin.end(options.input);
  else child.stdin.end();

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    options.outputObserver?.onFinish?.();
    flushCommandOutput(stdoutLogger);
    flushCommandOutput(stderrLogger);
  }
  logger.info({ command, exitCode, durationMs: durationMs(startedAt) }, "Codegen command finished");

  if (timedOut) {
    throw new Error(`${command} ${args.join(" ")} timed out after ${formatDuration(options.timeoutMs ?? 0)}: ${previewText(stderr || stdout, 1000)}`);
  }
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

type CommandOutputLogger = {
  command: string;
  stream: "stdout" | "stderr";
  throttled: boolean;
  lastLoggedAt: number;
  bufferedText: string;
  bufferedBytes: number;
  bufferedLines: number;
  bufferedChunks: number;
};

type CommandOutputObserver = {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onHeartbeat?: () => void;
  onFinish?: () => void;
  heartbeatMs?: number;
};

function createCommandOutputLogger(command: string, stream: "stdout" | "stderr"): CommandOutputLogger {
  return {
    command,
    stream,
    throttled: command === (process.env.CODEX_BIN || "codex") || path.basename(command) === "codex",
    lastLoggedAt: 0,
    bufferedText: "",
    bufferedBytes: 0,
    bufferedLines: 0,
    bufferedChunks: 0
  };
}

function logCommandOutput(output: CommandOutputLogger, text: string) {
  output.bufferedText = appendLimited(output.bufferedText, text);
  output.bufferedBytes += Buffer.byteLength(text);
  output.bufferedLines += text.split(/\r?\n/).filter((line) => line.trim()).length;
  output.bufferedChunks += 1;

  const now = Date.now();
  if (!output.throttled || output.lastLoggedAt === 0 || now - output.lastLoggedAt >= CODEX_OUTPUT_LOG_INTERVAL_MS) {
    flushCommandOutput(output, now);
  }
}

function flushCommandOutput(output: CommandOutputLogger, now = Date.now()) {
  if (output.bufferedBytes === 0) return;
  logger.info(
    {
      command: output.command,
      stream: output.stream,
      chunks: output.bufferedChunks,
      bytes: output.bufferedBytes,
      lines: output.bufferedLines,
      preview: previewText(output.bufferedText, 1000),
      throttled: output.throttled
    },
    output.throttled ? "Codegen command output summary" : "Codegen command output"
  );
  output.lastLoggedAt = now;
  output.bufferedText = "";
  output.bufferedBytes = 0;
  output.bufferedLines = 0;
  output.bufferedChunks = 0;
}

function redactedArgs(command: string, args: string[]) {
  if (command === "git" && args[0] === "clone") {
    return args.map((arg) => (arg.startsWith("https://github.com/") ? "https://github.com/[repo].git" : arg));
  }
  return args;
}

function minutesToMs(minutes: number) {
  return minutes * 60 * 1000;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function logCodexActivitySnapshot(job: AgentCodegenJob, snapshot: CodexActivitySnapshot) {
  logger.info(
    {
      requestId: job.requestId,
      updateName: job.updateName,
      ...codexActivityMetadata(snapshot)
    },
    snapshot.final ? "Codex activity final summary" : "Codex activity summary"
  );
}

function codexActivityProgressMessage(snapshot: CodexActivitySnapshot) {
  const parts = [`Codex is working (${formatDuration(snapshot.durationMs)} elapsed).`];
  if (snapshot.silentForMs >= CODEX_OUTPUT_LOG_INTERVAL_MS) {
    parts.push(`No Codex output for ${formatDuration(snapshot.silentForMs)}.`);
  }
  if (snapshot.commandStarts > 0) {
    parts.push(`Commands: ${snapshot.commandCompletions}/${snapshot.commandStarts} complete${snapshot.commandFailures ? `, ${snapshot.commandFailures} failed` : ""}.`);
  }
  if (snapshot.filePaths.length > 0) {
    parts.push(`Touched: ${snapshot.filePaths.slice(0, 3).join(", ")}${snapshot.filePaths.length > 3 ? "..." : ""}.`);
  }
  if (snapshot.lastActivity) {
    parts.push(`Latest: ${snapshot.lastActivity}.`);
  }
  return parts.join(" ");
}

function codexActivityMetadata(snapshot: CodexActivitySnapshot) {
  return {
    final: snapshot.final,
    durationMs: snapshot.durationMs,
    silentForMs: snapshot.silentForMs,
    longestOutputGapMs: snapshot.longestOutputGapMs,
    totalEvents: snapshot.totalEvents,
    topEventTypes: topEventTypes(snapshot.eventTypes),
    phase: snapshot.phase,
    phaseDurationsMs: snapshot.phaseDurationsMs,
    commandStarts: snapshot.commandStarts,
    commandCompletions: snapshot.commandCompletions,
    commandFailures: snapshot.commandFailures,
    activeCommands: snapshot.activeCommands,
    lastCommand: snapshot.lastCommand,
    recentCommands: snapshot.recentCommands,
    repeatedCommands: snapshot.repeatedCommands,
    fileChangeStarts: snapshot.fileChangeStarts,
    fileChangeCompletions: snapshot.fileChangeCompletions,
    filePaths: snapshot.filePaths,
    recentFileChanges: snapshot.recentFileChanges,
    planUpdates: snapshot.planUpdates,
    planSnippets: snapshot.planSnippets,
    reasoningChars: snapshot.reasoningChars,
    reasoningSnippets: snapshot.reasoningSnippets,
    messageChars: snapshot.messageChars,
    messageSnippets: snapshot.messageSnippets,
    toolUses: snapshot.toolUses,
    toolResults: snapshot.toolResults,
    jsonParseErrors: snapshot.jsonParseErrors,
    nonJsonLines: snapshot.nonJsonLines,
    stderrBytes: snapshot.stderrBytes,
    stderrSnippets: snapshot.stderrSnippets,
    recentActivities: snapshot.recentActivities,
    lastEventType: snapshot.lastEventType,
    lastActivity: snapshot.lastActivity
  };
}

function topEventTypes(eventTypes: Record<string, number>) {
  return Object.entries(eventTypes)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([type, count]) => ({ type, count }));
}
