import { loadConfig } from "../src/config/env.js";
import type { DiscordBugInboxStatus } from "../src/db/types.js";
import { resolveProductionControlPlane } from "./productionControlPlane.js";

type Snapshot = {
  generatedAt: string;
  requesterUserId: string;
  items: DiscordBugInboxStatus[];
  counts: { total: number; awaitingValidation: number; awaitingDeployment: number; retryFailed: number };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const control = resolveProductionControlPlane({
    apiUrl: args.apiUrl,
    auth: args.auth ?? config.controlUi.authPassword,
    namespace: config.execution.kubernetes.namespace,
  });
  const url = new URL("/api/bugs/status", control.apiUrl);
  url.searchParams.set("requesterUserId", args.requesterUserId);
  url.searchParams.set("limit", String(args.limit));
  const response = await fetch(url, { headers: control.auth ? { authorization: `Bearer ${control.auth}` } : undefined });
  if (!response.ok) throw new Error(`GET ${url.origin}${url.pathname} failed: ${response.status} ${await response.text()}`);
  const snapshot = await response.json() as Snapshot;
  process.stdout.write(args.json ? `${JSON.stringify(snapshot, null, 2)}\n` : formatBugStatus(snapshot));
}

export function formatBugStatus(snapshot: Snapshot) {
  const lines = [
    "Discord bug inbox status",
    `Generated: ${snapshot.generatedAt}`,
    `active markers: ${snapshot.counts.total} | awaiting validation: ${snapshot.counts.awaitingValidation} | awaiting deployment: ${snapshot.counts.awaitingDeployment} | retry failed: ${snapshot.counts.retryFailed}`,
  ];
  if (snapshot.items.length === 0) lines.push("", "No active markers for this requester.");
  snapshot.items.forEach((item, index) => {
    lines.push("", `[${index + 1}] marked ${new Date(item.markedAt).toISOString()}`);
    lines.push(`  validation: ${item.validationStatus}${item.disposition ? ` (${item.disposition})` : ""}`);
    lines.push(`  pull request: ${item.prUrl ?? "none"}`);
    lines.push(`  deployment: ${item.deployedRevision ?? "pending"}`);
    lines.push(`  original prompt retry: ${item.retryStatus ?? "pending"}`);
  });
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (!name || !value) throw new Error(`Missing value for --${name || arg}`);
    values.set(name, value);
  }
  const requesterUserId = values.get("requester");
  if (!requesterUserId || !/^\d{10,}$/.test(requesterUserId)) throw new Error("--requester must be a Discord user ID.");
  const limit = Number(values.get("limit") ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be between 1 and 100.");
  return { requesterUserId, limit, json, apiUrl: values.get("api-url"), auth: values.get("auth") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
import path from "node:path";
import { fileURLToPath } from "node:url";
