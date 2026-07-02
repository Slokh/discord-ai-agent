import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { collectCodegenStatusSnapshot, formatCodegenStatusSnapshot, type CodegenStatusSnapshot } from "../src/observability/codegenStatus.js";

type Args = {
  source: "db" | "api";
  apiUrl?: string;
  auth?: string;
  limit: number;
  staleAfterMs: number;
  json: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const snapshot =
    args.source === "api"
      ? await loadFromApi({
          apiUrl: (args.apiUrl ?? config.controlUi.publicUrl)?.replace(/\/$/, ""),
          auth: args.auth ?? config.controlUi.authPassword,
          args
        })
      : await loadFromDatabase(config, args);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatCodegenStatusSnapshot(snapshot));
}

async function loadFromDatabase(config: ReturnType<typeof loadConfig>, args: Args): Promise<CodegenStatusSnapshot> {
  const pool = createPool(config);
  try {
    return await collectCodegenStatusSnapshot(pool, { limit: args.limit, staleAfterMs: args.staleAfterMs });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function loadFromApi(input: { apiUrl?: string; auth?: string; args: Args }): Promise<CodegenStatusSnapshot> {
  if (!input.apiUrl) throw new Error("--api-url or CONTROL_UI_PUBLIC_URL is required with --source api.");
  const headers = input.auth ? { authorization: `Bearer ${input.auth}` } : undefined;
  const url = new URL("/api/codegen/status", input.apiUrl);
  url.searchParams.set("limit", String(input.args.limit));
  url.searchParams.set("staleMinutes", String(input.args.staleAfterMs / 60_000));
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url.toString()} failed: ${response.status} ${await response.text()}`);
  return reviveSnapshot((await response.json()) as CodegenStatusSnapshot);
}

function reviveSnapshot(value: CodegenStatusSnapshot): CodegenStatusSnapshot {
  return {
    ...value,
    generatedAt: new Date(value.generatedAt),
    activeTasks: value.activeTasks.map(reviveTask),
    recentTerminalTasks: value.recentTerminalTasks.map(reviveTask),
    activeSandboxRuns: value.activeSandboxRuns.map(reviveSandboxRun),
    pendingSandboxCleanup: value.pendingSandboxCleanup.map(reviveSandboxRun),
    leases: value.leases.map((lease) => ({
      ...lease,
      heartbeatAt: reviveNullableDate(lease.heartbeatAt),
      lastUsedAt: reviveNullableDate(lease.lastUsedAt),
      updatedAt: new Date(lease.updatedAt)
    }))
  };
}

function reviveTask(task: CodegenStatusSnapshot["activeTasks"][number]) {
  return {
    ...task,
    createdAt: new Date(task.createdAt),
    startedAt: reviveNullableDate(task.startedAt),
    completedAt: reviveNullableDate(task.completedAt),
    progressUpdatedAt: reviveNullableDate(task.progressUpdatedAt),
    updatedAt: new Date(task.updatedAt)
  };
}

function reviveSandboxRun(run: CodegenStatusSnapshot["activeSandboxRuns"][number]) {
  return {
    ...run,
    startedAt: reviveNullableDate(run.startedAt),
    completedAt: reviveNullableDate(run.completedAt),
    cleanedUpAt: reviveNullableDate(run.cleanedUpAt),
    updatedAt: new Date(run.updatedAt)
  };
}

function reviveNullableDate(value: Date | string | null) {
  return value == null ? null : new Date(value);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: process.env.CODEGEN_STATUS_SOURCE === "api" ? "api" : "db",
    limit: 10,
    staleAfterMs: 15 * 60 * 1000,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--source") {
      const source = nextValue(argv, index, arg);
      if (source !== "db" && source !== "api") throw new Error('--source must be "db" or "api".');
      args.source = source;
      index += 1;
      continue;
    }
    if (arg === "--api-url") {
      args.apiUrl = nextValue(argv, index, arg);
      args.source = "api";
      index += 1;
      continue;
    }
    if (arg === "--auth") {
      args.auth = nextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      args.limit = parseBoundedInteger(nextValue(argv, index, arg), 1, 100);
      index += 1;
      continue;
    }
    if (arg === "--stale-minutes") {
      args.staleAfterMs = parseBoundedFloat(nextValue(argv, index, arg), 0.1, 1440) * 60 * 1000;
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown option "${arg}".`);
  }

  return args;
}

function nextValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseBoundedInteger(value: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got "${value}".`);
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseBoundedFloat(value: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got "${value}".`);
  return Math.max(min, Math.min(max, parsed));
}

function printUsage() {
  process.stdout.write(`Inspect code-update task health.

Usage:
  npm run codegen:status -- [options]

Options:
  --source <db|api>          Data source. Default: db, or CODEGEN_STATUS_SOURCE=api.
  --api-url <url>            Control UI/API base URL. Implies --source api.
  --auth <password>          Control UI password for API mode. Defaults to CONTROL_UI_AUTH_PASSWORD.
  --limit <count>            Rows per section. Default: 10.
  --stale-minutes <minutes>  Mark active tasks/leases stale after this long without progress. Default: 15.
  --json                     Print raw JSON.

Examples:
  npm run codegen:status
  npm run codegen:status -- --limit 25 --stale-minutes 5
  npm run codegen:status -- --source api --api-url https://tasks.example.com
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
