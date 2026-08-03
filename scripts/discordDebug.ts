import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config/env.js";
import { extractDiscordMessageId } from "../src/observability/runs.js";
import { resolveProductionControlPlane } from "./productionControlPlane.js";

type Args = {
  help: boolean;
  audit: boolean;
  channelId?: string;
  reference?: string;
  since?: Date;
  sinceDeploy: boolean;
  includeReplyChains: boolean;
  apiUrl?: string;
  auth?: string;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string; bot?: boolean };
  mentions?: Array<{ id: string }>;
  message_reference?: { channel_id?: string; message_id?: string };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const config = loadConfig();
  const token = config.discord.token;
  if (!token) throw new Error("DISCORD_TOKEN is required.");
  const { apiUrl, auth } = resolveProductionControlPlane({
    apiUrl: args.apiUrl ?? config.controlUi.publicUrl,
    auth: args.auth ?? config.controlUi.authPassword,
    namespace: config.execution.kubernetes.namespace,
  });
  const discord = new DiscordReader(token);
  const bot = await discord.me();
  if (args.audit) {
    if (!args.channelId) throw new Error("--channel is required with --audit.");
    const since = args.since ?? (args.sinceDeploy ? deploymentStartedAt(config.execution.kubernetes.namespace) : undefined);
    if (!since) throw new Error("Provide --since <ISO timestamp> or --since-deploy.");
    const messages = await discord.messagesSince(args.channelId, since);
    const rows = await mapConcurrent(messages, 6, (message) =>
      auditRow({ message, botId: bot.id, discord, apiUrl, auth, includeReplyChains: args.includeReplyChains }));
    process.stdout.write(formatAudit({ channelId: args.channelId, since, rows }));
    return;
  }
  if (!args.reference) throw new Error("Provide a Discord message link, or use --audit.");
  const messageId = extractDiscordMessageId(args.reference);
  if (!messageId) throw new Error("Expected a Discord message ID or Discord message link.");
  const channelId = channelIdFromReference(args.reference);
  if (!channelId) throw new Error("Expected a Discord channel/message link for --debug.");
  const message = await discord.message(channelId, messageId);
  const chain = await replyChain(discord, message);
  const run = await loadRun(apiUrl, auth, messageId);
  process.stdout.write(await formatDebug({ message, chain, run, apiUrl, auth }));
}

class DiscordReader {
  constructor(private readonly token: string) {}
  async me() { return await this.get<{ id: string; username: string }>("/users/@me"); }
  async message(channelId: string, messageId: string) { return await this.get<DiscordMessage>(`/channels/${channelId}/messages/${messageId}`); }
  async messagesSince(channelId: string, since: Date) {
    const all: DiscordMessage[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const search = new URLSearchParams({ limit: "100" });
      if (before) search.set("before", before);
      const batch = await this.get<DiscordMessage[]>(`/channels/${channelId}/messages?${search}`);
      if (batch.length === 0) break;
      all.push(...batch);
      if (new Date(batch.at(-1)!.timestamp) < since) break;
      before = batch.at(-1)!.id;
    }
    return all.filter((message) => new Date(message.timestamp) >= since).sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
  }
  private async get<T>(path: string) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(`https://discord.com/api/v10${path}`, { headers: { authorization: `Bot ${this.token}` } });
      if (response.ok) return await response.json() as T;
      if (response.status !== 429 || attempt === 5) throw new Error(`Discord GET ${path} failed: ${response.status}`);
      const body = await response.json().catch(() => ({})) as { retry_after?: number };
      const headerDelayMs = Number(response.headers.get("retry-after")) * 1_000;
      const bodyDelayMs = Number(body.retry_after) * 1_000;
      const delayMs = Math.min(30_000, Math.max(250, Number.isFinite(bodyDelayMs) ? bodyDelayMs : headerDelayMs || 1_000));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Discord GET ${path} exhausted retries.`);
  }
}

async function auditRow(input: { message: DiscordMessage; botId: string; discord: DiscordReader; apiUrl: string; auth?: string; includeReplyChains: boolean }) {
  const isBotReply = input.message.author.id === input.botId;
  const directlyMentionsBot = input.message.mentions?.some((mention) => mention.id === input.botId) ?? false;
  // Resolve every non-bot message rather than relying only on a direct mention:
  // a server can invoke the bot through an AI role mention or another ingress form.
  const run = await loadRun(input.apiUrl, input.auth, isBotReply ? input.message.message_reference?.message_id ?? input.message.id : input.message.id);
  const isBotRequest = !isBotReply && (directlyMentionsBot || Boolean(run));
  const chain = input.includeReplyChains ? await replyChain(input.discord, input.message) : [];
  const warnings = run ? run.events.filter((event: any) => event.level === "warn" || event.level === "error").map((event: any) => event.name) : [];
  return {
    at: input.message.timestamp,
    id: input.message.id,
    kind: isBotReply ? "bot_reply" : isBotRequest ? "bot_request" : "message",
    author: input.message.author.username,
    content: compact(input.message.content, 220),
    replyChain: chain.map((entry) => entry.id),
    runId: run?.run?.runId ?? null,
    revision: run?.run?.metadata?.appRevision ?? null,
    tools: run ? run.events.filter((event: any) => event.name === "agent.tool.complete").map((event: any) => event.metadata?.toolName).filter(Boolean) : [],
    warnings,
    response: run ? finalAssistantText(run) : null,
  };
}

async function replyChain(discord: DiscordReader, message: DiscordMessage) {
  const chain: DiscordMessage[] = [];
  let current = message;
  for (let depth = 0; depth < 12; depth += 1) {
    const reference = current.message_reference;
    if (!reference?.message_id) break;
    try {
      current = await discord.message(reference.channel_id ?? current.channel_id, reference.message_id);
      chain.unshift(current);
    } catch { break; }
  }
  return chain;
}

async function loadRun(apiUrl: string, auth: string | undefined, messageId: string) {
  const headers = auth ? { authorization: `Bearer ${auth}` } : undefined;
  const resolved = await fetch(`${apiUrl.replace(/\/$/, "")}/api/runs/resolve?query=${encodeURIComponent(messageId)}`, { headers });
  if (resolved.status === 404) return null;
  if (!resolved.ok) throw new Error(`Run resolve failed: ${resolved.status}`);
  const { run } = await resolved.json() as { run: { runId: string } };
  const snapshot = await fetch(`${apiUrl.replace(/\/$/, "")}/api/runs/${encodeURIComponent(run.runId)}`, { headers });
  if (!snapshot.ok) throw new Error(`Run fetch failed: ${snapshot.status}`);
  return await snapshot.json() as any;
}

async function formatDebug(input: { message: DiscordMessage; chain: DiscordMessage[]; run: any; apiUrl: string; auth?: string }) {
  const lines = [
    `Discord message: ${input.message.id} | ${input.message.timestamp}`,
    `Ingress request: ${input.message.content}`,
    `Reply chain (${input.chain.length}): ${input.chain.map((entry) => `${entry.author.username}: ${compact(entry.content, 180)}`).join(" ← ") || "none"}`,
  ];
  if (!input.run) return `${lines.join("\n")}\nNo agent run matched this message.\n`;
  lines.push(`Run: ${input.run.run.runId} | revision=${input.run.run.metadata?.appRevision ?? "unknown"}`);
  lines.push(`Final reply: ${finalAssistantText(input.run) ?? "none"}`);
  const warnings = input.run.events.filter((event: any) => event.level === "warn").map((event: any) => `${event.name}: ${event.summary}`);
  if (warnings.length) lines.push(`Warnings: ${warnings.join(" | ")}`);
  const prompt = await latestPrompt(input.apiUrl, input.auth, input.run);
  if (prompt) {
    const messages = prompt.messages ?? [];
    const finalUser = [...messages].reverse().find((message: any) => message.role === "user");
    lines.push(`Operative user message: ${finalUser?.content ?? "missing"}`);
    lines.push(`Prompt tail: ${messages.slice(-8).map((message: any) => `${message.role}/${message.section ?? "unknown"}`).join(" → ")}`);
  }
  lines.push(`Tools: ${input.run.events.filter((event: any) => event.name === "agent.tool.complete").map((event: any) => event.metadata?.toolName).filter(Boolean).join(", ") || "none"}`);
  return `${lines.join("\n")}\n`;
}

async function latestPrompt(apiUrl: string, auth: string | undefined, run: any) {
  const artifact = [...run.artifacts].reverse().find((entry: any) => entry.kind === "model_prompt");
  if (!artifact) return null;
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/runs/${encodeURIComponent(run.run.runId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`, { headers: auth ? { authorization: `Bearer ${auth}` } : undefined });
  if (!response.ok) return null;
  try { return JSON.parse(await response.text()) as { messages?: any[] }; } catch { return null; }
}

function finalAssistantText(run: any) {
  return [...(run.agentTranscript ?? [])].reverse().find((message: any) => message.role === "assistant" && !message.metadata?.round)?.parts?.map((part: any) => part.text).filter(Boolean).join("\n") ?? null;
}
function compact(value: string, length: number) { return value.replace(/\s+/g, " ").slice(0, length); }
function formatAudit(input: { channelId: string; since: Date; rows: any[] }) {
  const relevant = input.rows.filter((row) => row.kind !== "message");
  const warnings = relevant.flatMap((row) => row.warnings.map((warning: string) => warning));
  return `${JSON.stringify({ channelId: input.channelId, since: input.since.toISOString(), messages: input.rows.length, relevant, warningClusters: counts(warnings) }, null, 2)}\n`;
}
function counts(values: string[]) { return [...new Map(values.map((value) => [value, values.filter((item) => item === value).length])).entries()].map(([name, count]) => ({ name, count })); }
function channelIdFromReference(reference: string) { try { const parts = new URL(reference).pathname.split("/").filter(Boolean); return parts[parts.indexOf("channels") + 2]; } catch { return undefined; } }
function deploymentStartedAt(namespace: string) {
  const value = kubectl(["-n", namespace, "get", "deployment", "discord-ai-agent-bot", "-o", "jsonpath={.status.conditions[?(@.type==\"Available\")].lastTransitionTime}"]);
  if (!value) throw new Error("Could not resolve the deployed bot timestamp; pass --since.");
  return new Date(value);
}
function kubectl(args: string[]) {
  try {
    return execFileSync("kubectl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
function parseArgs(argv: string[]): Args { const args: Args = { help: false, audit: false, sinceDeploy: false, includeReplyChains: false }; for (let index = 0; index < argv.length; index += 1) { const value = argv[index]!; if (value === "-h" || value === "--help") args.help = true; else if (value === "--audit") args.audit = true; else if (value === "--channel") args.channelId = argv[++index]; else if (value === "--since") args.since = new Date(argv[++index]!); else if (value === "--since-deploy") args.sinceDeploy = true; else if (value === "--include-reply-chains") args.includeReplyChains = true; else if (value === "--api-url") args.apiUrl = argv[++index]; else if (value === "--auth") args.auth = argv[++index]; else if (!value.startsWith("-")) args.reference = args.reference ? `${args.reference} ${value}` : value; else throw new Error(`Unknown option ${value}`); } if (args.since && Number.isNaN(+args.since)) throw new Error("--since must be an ISO timestamp."); return args; }

async function mapConcurrent<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    let index: number;
    while ((index = cursor++) < values.length) output[index] = await worker(values[index]!);
  }));
  return output;
}

function printUsage() {
  process.stdout.write(`Inspect production Discord messages and their canonical agent runs.\n\nUsage:\n  npm run discord:debug -- <discord-message-link>\n  npm run discord:audit -- --channel <id> (--since <ISO> | --since-deploy) [--include-reply-chains]\n`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
