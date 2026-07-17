import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_EVAL_DIR = "evals/prompts";
const DEFAULT_PRIVATE_EVAL_DIR = ".discord-ai-agent/evals";
const DEFAULT_OUTPUT_DIR = ".eval-runs";
const DEFAULT_TIMEOUT_MS = 300_000;

const evalPromptSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  prompt: z.string().min(1),
  notes: z.string().optional(),
  expectedTools: z.array(z.string().min(1)).default([]),
  expectedRequestedTools: z.array(z.string().min(1)).default([]),
  mustContain: z.array(z.string().min(1)).default([]),
  mustNotContain: z.array(z.string().min(1)).default([]),
  maxAnswerWords: z.number().int().positive().optional(),
  auditMustNotMatch: z
    .array(
      z
        .string()
        .min(1)
        .refine(
          (pattern) => {
            try {
              new RegExp(pattern, "iu");
              return true;
            } catch {
              return false;
            }
          },
          { message: "must be a valid regular expression" }
        )
    )
    .default([]),
  maxLatencyMs: z.number().int().positive().optional(),
  promptArgs: z.array(z.string().min(1)).default([]),
  noMemory: z.boolean().default(true),
  useDiscordMemory: z.boolean().default(false),
  timeoutMs: z.number().int().positive().optional(),
  skip: z.boolean().default(false),
  skipReason: z.string().optional()
});

const evalSuiteSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  prompts: z.array(evalPromptSchema).min(1)
});

export type EvalPrompt = z.infer<typeof evalPromptSchema>;
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export type EvalArgs = {
  files: string[];
  dirs: string[];
  includePrivate: boolean;
  outputDir: string;
  comparePath?: string;
  filter?: string;
  category?: string;
  dryRun: boolean;
  list: boolean;
  json: boolean;
  promptTimeoutMs: number;
};

export type PromptJsonOutput = {
  runId?: string;
  traceId?: string;
  guildId?: string;
  channelId?: string;
  channelName?: string | null;
  visibleChannelCount?: number;
  threadKey?: string | null;
  durationMs?: number;
  content: string;
  files?: Array<{ name: string; contentType?: string; bytes: number; path: string }>;
};

export type EvalTraceEvidence = {
  requestedTools: string[];
  selectedTools: string[];
  auditedTools: string[];
  /** One line per tool audit: "toolName argumentsSummary resultSummary", for auditMustNotMatch assertions. */
  toolAuditLines: string[];
  traceEventCount: number;
  toolAuditCount: number;
};

export type EvalCaseResult = {
  id: string;
  category: string;
  prompt: string;
  status: "passed" | "failed" | "error" | "skipped";
  durationMs: number;
  runId: string | null;
  traceId: string | null;
  answer: string;
  evidence: EvalTraceEvidence;
  failures: string[];
  notes?: string;
  stderr?: string;
  error?: string;
};

export type EvalRunReport = {
  generatedAt: string;
  durationMs: number;
  totals: {
    passed: number;
    failed: number;
    error: number;
    skipped: number;
    total: number;
  };
  results: EvalCaseResult[];
};

export type EvalComparisonStatus = "improved" | "regressed" | "changed" | "unchanged" | "new" | "removed";

export type EvalComparisonCase = {
  id: string;
  status: EvalComparisonStatus;
  beforeStatus: EvalCaseResult["status"] | null;
  afterStatus: EvalCaseResult["status"] | null;
  beforeDurationMs: number | null;
  afterDurationMs: number | null;
  beforeFailures: string[];
  afterFailures: string[];
  beforeRequestedTools: string[];
  afterRequestedTools: string[];
  beforeSelectedTools: string[];
  afterSelectedTools: string[];
};

export type EvalComparisonReport = {
  baselinePath: string;
  totals: Record<EvalComparisonStatus, number>;
  cases: EvalComparisonCase[];
};

type TraceEventLike = {
  eventName?: string;
  summary?: string | null;
  metadata?: Record<string, unknown>;
};

type ToolAuditLike = {
  toolName?: string;
  argumentsSummary?: string | null;
  resultSummary?: string | null;
};

async function main() {
  const args = parseEvalArgs(process.argv.slice(2));
  const prompts = await loadEvalPrompts(args);
  const selectedPrompts = filterPrompts(prompts, args);

  if (args.list) {
    for (const prompt of selectedPrompts) {
      process.stdout.write(`${prompt.id}\t${prompt.category}\t${prompt.prompt}\n`);
    }
    return;
  }

  if (args.dryRun) {
    process.stdout.write(`Validated ${selectedPrompts.length} eval prompt${selectedPrompts.length === 1 ? "" : "s"}.\n`);
    return;
  }

  const report = await runEvalPrompts(selectedPrompts, args);
  const comparison = args.comparePath ? compareEvalReports(await loadEvalReport(args.comparePath), report, args.comparePath) : null;
  const outputPath = await writeEvalReport(report, args.outputDir, comparison);
  const hasFailures = report.totals.failed > 0 || report.totals.error > 0;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ outputPath, comparison, ...report }, null, 2)}\n`);
    process.exitCode = hasFailures ? 1 : 0;
    return;
  }

  process.stdout.write(formatEvalSummary(report, outputPath, comparison));
  process.exitCode = hasFailures ? 1 : 0;
}

export function parseEvalArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    files: [],
    dirs: [DEFAULT_EVAL_DIR],
    includePrivate: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    dryRun: false,
    list: false,
    json: false,
    promptTimeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--file") {
      args.files.push(requiredNext(argv, ++index, arg));
    } else if (arg.startsWith("--file=")) {
      args.files.push(valueAfterEquals(arg));
    } else if (arg === "--dir") {
      args.dirs.push(requiredNext(argv, ++index, arg));
    } else if (arg.startsWith("--dir=")) {
      args.dirs.push(valueAfterEquals(arg));
    } else if (arg === "--include-private") {
      args.includePrivate = true;
    } else if (arg === "--output-dir") {
      args.outputDir = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--output-dir=")) {
      args.outputDir = valueAfterEquals(arg);
    } else if (arg === "--compare") {
      args.comparePath = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--compare=")) {
      args.comparePath = valueAfterEquals(arg);
    } else if (arg === "--filter") {
      args.filter = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--filter=")) {
      args.filter = valueAfterEquals(arg);
    } else if (arg === "--category") {
      args.category = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--category=")) {
      args.category = valueAfterEquals(arg);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--list") {
      args.list = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--prompt-timeout-ms") {
      args.promptTimeoutMs = positiveInteger(requiredNext(argv, ++index, arg), arg);
    } else if (arg.startsWith("--prompt-timeout-ms=")) {
      args.promptTimeoutMs = positiveInteger(valueAfterEquals(arg), "--prompt-timeout-ms");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (args.includePrivate) args.dirs.push(DEFAULT_PRIVATE_EVAL_DIR);
  return args;
}

export async function loadEvalPrompts(args: Pick<EvalArgs, "files" | "dirs">): Promise<EvalPrompt[]> {
  const files = new Set<string>();
  for (const file of args.files) files.add(path.resolve(file));
  for (const dir of args.dirs) {
    for (const file of await jsonFilesUnder(dir)) files.add(path.resolve(file));
  }

  const suites: EvalSuite[] = [];
  for (const file of [...files].sort()) {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    const suite = evalSuiteSchema.parse(raw);
    suites.push(suite);
  }

  const prompts = suites.flatMap((suite) => suite.prompts);
  const seen = new Set<string>();
  for (const prompt of prompts) {
    if (seen.has(prompt.id)) throw new Error(`Duplicate eval prompt id: ${prompt.id}`);
    seen.add(prompt.id);
  }
  return prompts;
}

export function filterPrompts(prompts: EvalPrompt[], args: Pick<EvalArgs, "filter" | "category">): EvalPrompt[] {
  const category = args.category?.toLowerCase();
  const filter = args.filter?.toLowerCase();
  return prompts.filter((prompt) => {
    if (category && prompt.category.toLowerCase() !== category) return false;
    if (!filter) return true;
    return [prompt.id, prompt.category, prompt.prompt, prompt.notes ?? ""].some((value) => value.toLowerCase().includes(filter));
  });
}

export async function runEvalPrompts(prompts: EvalPrompt[], args: EvalArgs): Promise<EvalRunReport> {
  const startedAt = Date.now();
  const results: EvalCaseResult[] = [];
  const traceReader = await createTraceReader().catch(() => null);

  try {
    for (const prompt of prompts) {
      results.push(await runEvalPrompt(prompt, args, traceReader));
    }
  } finally {
    await traceReader?.close().catch(() => undefined);
  }

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    totals: countTotals(results),
    results
  };
}

async function runEvalPrompt(
  prompt: EvalPrompt,
  args: EvalArgs,
  traceReader: Awaited<ReturnType<typeof createTraceReader>> | null
): Promise<EvalCaseResult> {
  const startedAt = Date.now();
  if (prompt.skip) {
    return {
      id: prompt.id,
      category: prompt.category,
      prompt: prompt.prompt,
      status: "skipped",
      durationMs: 0,
      runId: null,
      traceId: null,
      answer: "",
      evidence: emptyEvidence(),
      failures: [],
      notes: prompt.skipReason ?? prompt.notes
    };
  }

  const command = buildPromptCommand(prompt);
  const result = await spawnWithOutput(command.command, command.args, {
    timeoutMs: prompt.timeoutMs ?? args.promptTimeoutMs,
    env: { ...process.env, LOG_LEVEL: "warn" }
  });
  const durationMs = Date.now() - startedAt;

  if (result.exitCode !== 0) {
    return {
      id: prompt.id,
      category: prompt.category,
      prompt: prompt.prompt,
      status: "error",
      durationMs,
      runId: null,
      traceId: null,
      answer: "",
      evidence: emptyEvidence(),
      failures: [`prompt command exited with ${result.exitCode}`],
      notes: prompt.notes,
      stderr: result.stderr,
      error: result.error
    };
  }

  let output: PromptJsonOutput;
  try {
    output = extractPromptJson(result.stdout);
  } catch (error) {
    return {
      id: prompt.id,
      category: prompt.category,
      prompt: prompt.prompt,
      status: "error",
      durationMs,
      runId: null,
      traceId: null,
      answer: result.stdout.trim(),
      evidence: emptyEvidence(),
      failures: ["prompt command did not return parseable JSON"],
      notes: prompt.notes,
      stderr: result.stderr,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const traceId = output.traceId ?? output.runId ?? null;
  const evidence = traceId && traceReader ? await traceReader.read(traceId).catch(() => emptyEvidence()) : emptyEvidence();
  const failures = evaluatePromptAssertions(prompt, {
    answer: output.content,
    durationMs: output.durationMs ?? durationMs,
    evidence
  });

  return {
    id: prompt.id,
    category: prompt.category,
    prompt: prompt.prompt,
    status: failures.length === 0 ? "passed" : "failed",
    durationMs: output.durationMs ?? durationMs,
    runId: output.runId ?? null,
    traceId,
    answer: output.content,
    evidence,
    failures,
    notes: prompt.notes,
    stderr: result.stderr.trim() || undefined
  };
}

export function buildPromptCommand(prompt: EvalPrompt): { command: string; args: string[] } {
  const args = ["run", "prompt", "--", "--json"];
  if (prompt.noMemory) args.push("--no-memory");
  if (prompt.useDiscordMemory) args.push("--use-discord-memory");
  args.push(...prompt.promptArgs, prompt.prompt);
  return { command: "npm", args };
}

export function evaluatePromptAssertions(
  prompt: EvalPrompt,
  output: { answer: string; durationMs: number; evidence: EvalTraceEvidence }
): string[] {
  const failures: string[] = [];
  const normalizedAnswer = output.answer.toLowerCase();
  const observedTools = new Set([...output.evidence.selectedTools, ...output.evidence.auditedTools]);
  const requestedTools = new Set(output.evidence.requestedTools);

  for (const tool of prompt.expectedTools) {
    if (!observedTools.has(tool)) failures.push(`expected tool ${tool} was not observed`);
  }
  for (const tool of prompt.expectedRequestedTools) {
    if (!requestedTools.has(tool)) failures.push(`expected requested tool ${tool} was not observed`);
  }
  for (const text of prompt.mustContain) {
    if (!normalizedAnswer.includes(text.toLowerCase())) failures.push(`answer did not contain required text: ${text}`);
  }
  for (const text of prompt.mustNotContain) {
    if (normalizedAnswer.includes(text.toLowerCase())) failures.push(`answer contained forbidden text: ${text}`);
  }
  if (prompt.maxAnswerWords != null) {
    const wordCount = output.answer.trim() ? output.answer.trim().split(/\s+/u).length : 0;
    if (wordCount > prompt.maxAnswerWords) {
      failures.push(`answer length ${wordCount} words exceeded the ${prompt.maxAnswerWords}-word limit`);
    }
  }
  for (const pattern of prompt.auditMustNotMatch) {
    const regex = new RegExp(pattern, "iu");
    const match = output.evidence.toolAuditLines.find((line) => regex.test(line));
    if (match !== undefined) failures.push(`tool audit matched forbidden pattern ${pattern}: ${match}`);
  }
  if (prompt.maxLatencyMs != null && output.durationMs > prompt.maxLatencyMs) {
    failures.push(`latency ${output.durationMs}ms exceeded ${prompt.maxLatencyMs}ms`);
  }

  return failures;
}

export function extractPromptJson(stdout: string): PromptJsonOutput {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found in prompt stdout.");
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as PromptJsonOutput;
  if (!parsed || typeof parsed.content !== "string") throw new Error("Prompt JSON output is missing content.");
  return parsed;
}

async function createTraceReader() {
  const [{ loadConfig }, { createPool }, { DiscordAiAgentRepository }] = await Promise.all([
    import("../src/config/env.js"),
    import("../src/db/pool.js"),
    import("../src/db/repositories.js")
  ]);
  const config = loadConfig();
  const pool = createPool(config);
  const repo = new DiscordAiAgentRepository(pool);
  return {
    async read(traceId: string): Promise<EvalTraceEvidence> {
      const [traceEvents, toolAudits] = await Promise.all([
        repo.getTraceEventsForTrace({ traceId, limit: 500 }),
        repo.getToolAuditLogsForTrace({ traceId, limit: 300 })
      ]);
      return evidenceFromTrace(traceEvents, toolAudits);
    },
    close: () => pool.end()
  };
}

export function evidenceFromTrace(traceEvents: TraceEventLike[], toolAudits: ToolAuditLike[]): EvalTraceEvidence {
  const requestedTools: string[] = [];
  const selectedTools: string[] = [];
  for (const event of traceEvents) {
    const metadata = event.metadata ?? {};
    requestedTools.push(...stringArray(metadata.requestedToolCalls));
    requestedTools.push(...toolNamesFromRequests(metadata.requestedToolRequests));
    selectedTools.push(...stringArray(metadata.selectedLocalTools));
    selectedTools.push(...toolNamesFromRequests(metadata.selectedLocalToolRequests));
  }
  return {
    requestedTools: uniqueStrings(requestedTools),
    selectedTools: uniqueStrings(selectedTools),
    auditedTools: uniqueStrings(toolAudits.map((audit) => audit.toolName).filter((tool): tool is string => Boolean(tool))),
    toolAuditLines: toolAudits.map((audit) =>
      [audit.toolName, audit.argumentsSummary, audit.resultSummary].filter(Boolean).join(" ")
    ),
    traceEventCount: traceEvents.length,
    toolAuditCount: toolAudits.length
  };
}

async function writeEvalReport(report: EvalRunReport, outputDir: string, comparison: EvalComparisonReport | null = null) {
  const runDir = path.join(outputDir, report.generatedAt.replace(/[:.]/g, "-"));
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (comparison) await fs.writeFile(path.join(runDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, "summary.md"), formatEvalSummary(report, path.join(runDir, "results.json"), comparison));
  return runDir;
}

export function formatEvalSummary(report: EvalRunReport, outputPath: string, comparison: EvalComparisonReport | null = null) {
  const lines = [
    `Eval results: ${report.totals.passed}/${report.totals.total} passed (${report.totals.failed} failed, ${report.totals.error} errors)`,
    `Duration: ${(report.durationMs / 1000).toFixed(3)}s`,
    `Output: ${outputPath}`,
    ""
  ];
  for (const result of report.results) {
    const metadata = [
      result.category,
      `${(result.durationMs / 1000).toFixed(3)}s`,
      `requested: ${compactList(result.evidence.requestedTools)}`,
      `local: ${compactList(result.evidence.selectedTools)}`,
      `audited: ${compactList(result.evidence.auditedTools)}`
    ];
    if (result.runId) metadata.push(`run: ${result.runId}`);
    if (result.traceId && result.traceId !== result.runId) metadata.push(`trace: ${result.traceId}`);
    lines.push(`- ${result.status.toUpperCase()} ${result.id} (${metadata.join("; ")})`);
    for (const failure of result.failures) lines.push(`  - ${failure}`);
    if ((result.status === "failed" || result.status === "error") && result.answer.trim()) {
      lines.push(`  - answer: ${previewForSummary(result.answer)}`);
    }
    if (result.error) lines.push(`  - error: ${previewForSummary(result.error)}`);
  }
  if (comparison) {
    lines.push("", ...formatEvalComparison(comparison));
  }
  return `${lines.join("\n")}\n`;
}

export function compareEvalReports(baseline: EvalRunReport, current: EvalRunReport, baselinePath: string): EvalComparisonReport {
  const beforeById = new Map(baseline.results.map((result) => [result.id, result]));
  const afterById = new Map(current.results.map((result) => [result.id, result]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  const totals: Record<EvalComparisonStatus, number> = {
    improved: 0,
    regressed: 0,
    changed: 0,
    unchanged: 0,
    new: 0,
    removed: 0
  };
  const cases = ids.map((id) => {
    const before = beforeById.get(id) ?? null;
    const after = afterById.get(id) ?? null;
    const status = comparisonStatus(before?.status ?? null, after?.status ?? null);
    totals[status] += 1;
    return {
      id,
      status,
      beforeStatus: before?.status ?? null,
      afterStatus: after?.status ?? null,
      beforeDurationMs: before?.durationMs ?? null,
      afterDurationMs: after?.durationMs ?? null,
      beforeFailures: before?.failures ?? [],
      afterFailures: after?.failures ?? [],
      beforeRequestedTools: before?.evidence.requestedTools ?? [],
      afterRequestedTools: after?.evidence.requestedTools ?? [],
      beforeSelectedTools: before?.evidence.selectedTools ?? [],
      afterSelectedTools: after?.evidence.selectedTools ?? []
    };
  });
  return { baselinePath, totals, cases };
}

function comparisonStatus(before: EvalCaseResult["status"] | null, after: EvalCaseResult["status"] | null): EvalComparisonStatus {
  if (!before) return "new";
  if (!after) return "removed";
  if (before !== "passed" && after === "passed") return "improved";
  if (before === "passed" && after !== "passed") return "regressed";
  if (before !== after) return "changed";
  return "unchanged";
}

function formatEvalComparison(comparison: EvalComparisonReport) {
  const lines = [
    `Comparison: ${comparison.baselinePath}`,
    `Improved: ${comparison.totals.improved}, regressed: ${comparison.totals.regressed}, changed: ${comparison.totals.changed}, new: ${comparison.totals.new}, removed: ${comparison.totals.removed}, unchanged: ${comparison.totals.unchanged}`
  ];
  const notable = comparison.cases.filter((result) => result.status !== "unchanged");
  for (const result of notable) {
    lines.push(`- ${result.status.toUpperCase()} ${result.id}: ${result.beforeStatus ?? "none"} -> ${result.afterStatus ?? "none"}${formatDurationDelta(result.beforeDurationMs, result.afterDurationMs)}`);
    for (const failure of result.afterFailures) lines.push(`  - ${failure}`);
    if (!sameStringList(result.beforeRequestedTools, result.afterRequestedTools)) {
      lines.push(`  - requested: ${compactList(result.beforeRequestedTools)} -> ${compactList(result.afterRequestedTools)}`);
    }
    if (!sameStringList(result.beforeSelectedTools, result.afterSelectedTools)) {
      lines.push(`  - local: ${compactList(result.beforeSelectedTools)} -> ${compactList(result.afterSelectedTools)}`);
    }
  }
  return lines;
}

async function loadEvalReport(inputPath: string): Promise<EvalRunReport> {
  const stats = await fs.stat(inputPath);
  const reportPath = stats.isDirectory() ? path.join(inputPath, "results.json") : inputPath;
  const parsed = JSON.parse(await fs.readFile(reportPath, "utf8")) as EvalRunReport;
  if (!parsed || !Array.isArray(parsed.results)) throw new Error(`Invalid eval report: ${reportPath}`);
  return parsed;
}

function compactList(values: string[]) {
  return values.length ? values.join(", ") : "none";
}

function previewForSummary(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function formatDurationDelta(before: number | null, after: number | null) {
  if (before == null || after == null) return "";
  const deltaSeconds = (after - before) / 1000;
  const sign = deltaSeconds > 0 ? "+" : "";
  return ` (${sign}${deltaSeconds.toFixed(3)}s)`;
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function countTotals(results: EvalCaseResult[]): EvalRunReport["totals"] {
  const totals = { passed: 0, failed: 0, error: 0, skipped: 0, total: results.length };
  for (const result of results) totals[result.status] += 1;
  return totals;
}

async function jsonFilesUnder(dir: string): Promise<string[]> {
  const absolute = path.resolve(dir);
  const entries = await fs.readdir(absolute, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await jsonFilesUnder(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function spawnWithOutput(command: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; error?: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ exitCode: null, stdout, stderr, error: `Timed out after ${options.timeoutMs}ms.` });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function toolNamesFromRequests(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const name = (item as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name] : [];
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function emptyEvidence(): EvalTraceEvidence {
  return {
    requestedTools: [],
    selectedTools: [],
    auditedTools: [],
    toolAuditLines: [],
    traceEventCount: 0,
    toolAuditCount: 0
  };
}

function valueAfterEquals(arg: string) {
  return arg.slice(arg.indexOf("=") + 1).trim();
}

function requiredNext(argv: string[], index: number, option: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function positiveInteger(value: string, option: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer.`);
  return parsed;
}

function printUsage() {
  process.stdout.write(`Usage:
  npm run eval
  npm run eval -- --dry-run
  npm run eval -- --include-private --category history
  npm run eval -- --file evals/prompts/core.json --filter birthday

Options:
  --file <path>              Load one eval suite JSON file. Repeatable.
  --dir <path>               Load all JSON suites under a directory. Defaults to evals/prompts.
  --include-private          Also load .discord-ai-agent/evals, which is gitignored.
  --output-dir <path>        Report output directory. Defaults to .eval-runs.
  --compare <path>           Compare against a previous results.json file or eval run directory.
  --filter <text>            Keep prompts whose id, category, prompt, or notes include text.
  --category <name>          Keep prompts in one category.
  --prompt-timeout-ms <ms>   Per-prompt timeout. Defaults to 300000.
  --list                     List selected prompts without running them.
  --dry-run                  Validate selected prompts without running them.
  --json                     Print the final report as JSON.
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
