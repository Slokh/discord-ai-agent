import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository } from "../src/db/repositories.js";
import { formatRunArtifacts, formatRunInspection, formatRunSummaryList, selectArtifacts } from "../src/observability/runInspector.js";
import { getRunSnapshot, listRunSummaries, resolveRunReference } from "../src/observability/runs.js";
import type { RunSnapshot, RunSummary } from "../src/observability/runTypes.js";

type Args = {
  reference: string;
  source: "db" | "api";
  apiUrl?: string;
  auth?: string;
  json: boolean;
  includeDebug: boolean;
  includeMetadata: boolean;
  includeTerminal: boolean;
  includeEmbeddings: boolean;
  list: boolean;
  kind?: string;
  status?: string;
  sort: "updated" | "started" | "slowest";
  eventLimit: number;
  terminalLimit: number;
  artifactSelector?: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reference && !args.list) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const source = args.source;
  if (source === "api") {
    const apiUrl = (args.apiUrl ?? config.controlUi.publicUrl)?.replace(/\/$/, "");
    if (!apiUrl) throw new Error("--api-url or CONTROL_UI_PUBLIC_URL is required with --source api.");
    const auth = args.auth ?? config.controlUi.authPassword;
    if (args.list) {
      const runs = await loadRunListFromApi({ apiUrl, auth, args });
      writeRunList(runs, args);
      return;
    }
    const { snapshot, artifactContents } = await loadFromApi({ apiUrl, auth, args });
    writeSnapshot(snapshot, args);
    if (artifactContents.length > 0) process.stdout.write(`\n${formatRunArtifacts(artifactContents)}`);
    return;
  }

  const pool = createPool(config);
  try {
    const repo = new DiscordAiAgentRepository(pool);
    if (args.list) {
      const runs = await listRunSummaries(repo, { limit: listFetchLimit(args), includeEmbeddings: args.includeEmbeddings });
      writeRunList(runs, args);
      return;
    }
    const runId = await resolveRunId(repo, args.reference);
    const snapshot = await getRunSnapshot(repo, runId);
    if (!snapshot) throw new Error(`No run found for "${args.reference}" (resolved as "${runId}").`);
    writeSnapshot(snapshot, args);
    if (args.artifactSelector) {
      const selected = selectArtifacts(snapshot.artifacts, args.artifactSelector);
      const contents = (
        await Promise.all(selected.map((artifact) => repo.getProcessRunArtifact({ runId: snapshot.run.runId, artifactId: artifact.artifactId })))
      ).filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
      process.stdout.write(`\n${formatRunArtifacts(contents)}`);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function writeRunList(runs: RunSummary[], args: Args) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ runs }, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatRunSummaryList(runs, { kind: args.kind, status: args.status, sort: args.sort, limit: args.eventLimit }));
}

function writeSnapshot(snapshot: RunSnapshot, args: Args) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    formatRunInspection(snapshot, {
      eventLimit: args.eventLimit,
      includeDebug: args.includeDebug,
      includeMetadata: args.includeMetadata,
      includeTerminal: args.includeTerminal,
      terminalLimit: args.terminalLimit
    })
  );
}

async function resolveRunId(repo: DiscordAiAgentRepository, reference: string) {
  const resolved = await resolveRunReference(repo, reference);
  return resolved?.run.runId ?? reference.trim();
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    reference: "",
    source: process.env.RUNS_INSPECT_SOURCE === "api" ? "api" : "db",
    json: false,
    includeDebug: false,
    includeMetadata: false,
    includeTerminal: false,
    includeEmbeddings: false,
    list: false,
    sort: "updated",
    eventLimit: 80,
    terminalLimit: 40
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
    if (arg === "--debug") {
      args.includeDebug = true;
      continue;
    }
    if (arg === "--metadata") {
      args.includeMetadata = true;
      continue;
    }
    if (arg === "--terminal") {
      args.includeTerminal = true;
      continue;
    }
    if (arg === "--list" || arg === "--recent") {
      args.list = true;
      continue;
    }
    if (arg === "--include-embeddings") {
      args.includeEmbeddings = true;
      continue;
    }
    if (arg === "--kind") {
      args.kind = nextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--status") {
      args.status = nextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--sort") {
      const sort = nextValue(argv, index, arg);
      if (sort !== "updated" && sort !== "started" && sort !== "slowest") throw new Error('--sort must be "updated", "started", or "slowest".');
      args.sort = sort;
      index += 1;
      continue;
    }
    if (arg === "--artifact" || arg === "--artifacts") {
      args.artifactSelector = nextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      args.eventLimit = parseBoundedInteger(nextValue(argv, index, arg), 1, 500);
      index += 1;
      continue;
    }
    if (arg === "--terminal-limit") {
      args.terminalLimit = parseBoundedInteger(nextValue(argv, index, arg), 1, 500);
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}".`);
    args.reference = args.reference ? `${args.reference} ${arg}` : arg;
  }

  return args;
}

async function loadRunListFromApi(input: { apiUrl: string; auth?: string; args: Args }) {
  const headers = input.auth ? { authorization: `Bearer ${input.auth}` } : undefined;
  const url = new URL(`${input.apiUrl}/api/runs`);
  url.searchParams.set("limit", String(listFetchLimit(input.args)));
  if (input.args.includeEmbeddings) url.searchParams.set("includeEmbeddings", "1");
  const response = await fetchJson<{ runs?: unknown[] }>(url.toString(), headers);
  return (response?.runs ?? []).map(reviveRunSummary);
}

async function loadFromApi(input: { apiUrl: string; auth?: string; args: Args }) {
  const headers = input.auth ? { authorization: `Bearer ${input.auth}` } : undefined;
  const resolved = await fetchJson<{ run?: { runId?: string } }>(
    `${input.apiUrl}/api/runs/resolve?query=${encodeURIComponent(input.args.reference)}`,
    headers,
    { optionalNotFound: true }
  );
  const runId = resolved?.run?.runId ?? input.args.reference.trim();
  const snapshot = reviveRunSnapshot(await fetchJson<unknown>(`${input.apiUrl}/api/runs/${encodeURIComponent(runId)}`, headers));
  const artifactContents = [];
  if (input.args.artifactSelector) {
    const selected = selectArtifacts(snapshot.artifacts, input.args.artifactSelector);
    for (const artifact of selected) {
      const content = await fetchText(`${input.apiUrl}/api/runs/${encodeURIComponent(snapshot.run.runId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`, headers);
      artifactContents.push({ ...artifact, content });
    }
  }
  return { snapshot, artifactContents };
}

function listFetchLimit(args: Args) {
  return args.sort === "slowest" || args.kind || args.status ? Math.max(args.eventLimit, 100) : args.eventLimit;
}

async function fetchJson<T>(url: string, headers: Record<string, string> | undefined, options: { optionalNotFound?: boolean } = {}): Promise<T | undefined> {
  const response = await fetch(url, { headers });
  if (options.optionalNotFound && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function fetchText(url: string, headers: Record<string, string> | undefined) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  return await response.text();
}

function reviveRunSnapshot(value: unknown): RunSnapshot {
  const snapshot = value as RunSnapshot;
  snapshot.run.startedAt = new Date(snapshot.run.startedAt);
  snapshot.run.completedAt = snapshot.run.completedAt ? new Date(snapshot.run.completedAt) : null;
  snapshot.run.updatedAt = new Date(snapshot.run.updatedAt);
  for (const span of snapshot.spans) {
    span.startedAt = new Date(span.startedAt);
    span.completedAt = span.completedAt ? new Date(span.completedAt) : null;
  }
  for (const event of snapshot.events) event.createdAt = new Date(event.createdAt);
  for (const artifact of snapshot.artifacts) {
    artifact.createdAt = new Date(artifact.createdAt);
    artifact.expiresAt = artifact.expiresAt ? new Date(artifact.expiresAt) : null;
  }
  for (const message of snapshot.agentTranscript ?? []) message.createdAt = new Date(message.createdAt);
  for (const entry of snapshot.terminal.entries) entry.createdAt = new Date(entry.createdAt);
  snapshot.generatedAt = new Date(snapshot.generatedAt);
  return snapshot;
}

function reviveRunSummary(value: unknown): RunSummary {
  const run = value as RunSummary;
  run.startedAt = new Date(run.startedAt);
  run.completedAt = run.completedAt ? new Date(run.completedAt) : null;
  run.updatedAt = new Date(run.updatedAt);
  return run;
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

function printUsage() {
  process.stdout.write(`Inspect an agent run from Postgres.

Usage:
  npm run runs:inspect -- <run-id-or-discord-message-link> [options]
  npm run runs:inspect -- --list [options]

Options:
  --source <db|api>           Data source. Default: db, or RUNS_INSPECT_SOURCE=api.
  --api-url <url>             Control UI/API base URL. Implies --source api.
  --auth <password>           Control UI password for API mode. Defaults to CONTROL_UI_AUTH_PASSWORD.
  --list, --recent            List recent runs instead of inspecting one run.
  --kind <kind>               Filter list mode by run kind, e.g. codegen, discord, prompt.
  --status <status>           Filter list mode by status, e.g. failed, no_changes, running.
  --sort <updated|started|slowest>
                              Sort list mode. Default: updated.
  --include-embeddings        Include embedding runs in list mode.
  --terminal                 Include terminal command output tail.
  --terminal-limit <count>   Terminal entries to print when --terminal is set. Default: 40.
  --artifact <selector>      Print full matching artifact content. Use "all" for every artifact.
  --limit <count>            Timeline items to print. Default: 80.
  --metadata                 Include metadata JSON under timeline rows.
  --debug                    Include debug-level events.
  --json                     Print the raw run snapshot JSON.

Examples:
  npm run runs:inspect -- task-1782927645982-4bdd1c91
  npm run runs:inspect -- --list --kind codegen --sort slowest --limit 10
  npm run runs:inspect -- https://discord.com/channels/123/456/789 --terminal
  npm run runs:inspect -- --api-url https://tasks.example task-1782927645982-4bdd1c91
  npm run runs:inspect -- task-1782927645982-4bdd1c91 --artifact "Codex prompt"
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
