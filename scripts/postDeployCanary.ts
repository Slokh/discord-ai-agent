import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as k8s from "@kubernetes/client-node";
import { Octokit } from "@octokit/rest";
import {
  assertDiscordConfig,
  assertExecutionConfig,
  assertOpenRouterConfig,
  loadConfig,
} from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { resolveGitHubTaskToken } from "../src/execution/githubAuth.js";
import { parseGitHubRepository } from "../src/github/repository.js";
import { deploymentToolset } from "../src/tools/toolScope.js";

const execFileAsync = promisify(execFile);
const config = loadConfig();
assertDiscordConfig(config);
assertOpenRouterConfig(config);
assertExecutionConfig(config);

const deployed = deploymentToolset(config);
for (const name of ["getDiscordStats", "searchDiscordHistory", "runCodingAgent", "researchWeb"] as const) {
  if (!deployed.localTools.some((tool) => tool.name === name)) throw new Error(`Post-deploy canary is missing deployed capability ${name}.`);
}
for (const type of ["openrouter:web_search", "openrouter:web_fetch"] as const) {
  if (!deployed.serverTools.some((tool) => tool.type === type)) throw new Error(`Post-deploy canary is missing server capability ${type}.`);
}

await Promise.all([verifyGitHub(), verifySandboxScheduling()]);

const promptScript = fileURLToPath(new URL("./prompt.js", import.meta.url));
const prompt = [
  "This is an automated private post-deploy canary.",
  "Use getDiscordStats to count messages in the current channel.",
  "Use researchWeb exactly once to find the current UTC date from a reliable public source.",
  "Do not retry either tool; report a failure immediately if a tool fails.",
  "Reply with POST_DEPLOY_CANARY_OK, the numeric message count, and the UTC date.",
  "Do not quote, summarize, or identify any Discord message or member.",
].join(" ");
const { stdout } = await execFileAsync(process.execPath, [
  promptScript,
  "--no-memory",
  "--json",
  "--user-id", "post-deploy-canary",
  "--user-name", "Post-deploy canary",
  prompt,
], {
  cwd: process.cwd(),
  env: { ...process.env, LOG_LEVEL: "warn" },
  timeout: 7 * 60 * 1_000,
  maxBuffer: 2 * 1024 * 1024,
});
const output = promptJson(stdout);
if (!output.content.includes("POST_DEPLOY_CANARY_OK")) throw new Error("Conversation canary did not return its completion marker.");

const pool = createPool(config);
let deliveryChannelId: string | undefined;
try {
  const [tool, web, execution] = await Promise.all([
    pool.query(
      `SELECT 1
       FROM agent_runtime_events
       WHERE trace_id = $1
         AND event_name = 'agent.tool.complete'
         AND metadata->>'toolName' = 'getDiscordStats'
         AND coalesce(metadata->>'status', 'ok') <> 'error'
       LIMIT 1`,
      [output.traceId],
    ),
    pool.query(
      `SELECT 1
       FROM agent_runtime_events
       WHERE trace_id = $1
         AND event_name = 'agent.model.call.completed'
         AND EXISTS (
           SELECT 1
           FROM jsonb_each_text(coalesce(metadata->'serverToolUse', '{}'::jsonb)) AS usage(name, count)
           WHERE count::integer > 0
         )
       LIMIT 1`,
      [output.traceId],
    ),
    pool.query(
      `SELECT session.channel_id
       FROM agent_runtime_executions execution
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE execution.trace_id = $1
       ORDER BY execution.created_at DESC
       LIMIT 1`,
      [output.traceId],
    ),
  ]);
  if (tool.rowCount !== 1) throw new Error("Conversation canary did not complete its permission-scoped retrieval tool.");
  if (web.rowCount !== 1) throw new Error("Conversation canary did not execute a hosted web tool.");
  deliveryChannelId = typeof execution.rows[0]?.channel_id === "string" ? execution.rows[0].channel_id : undefined;
  if (!deliveryChannelId) throw new Error("Conversation canary did not retain its Discord channel scope.");
} finally {
  await pool.end();
}

await verifyDiscordDelivery(deliveryChannelId);
process.stdout.write("Post-deploy canary passed: model, retrieval, hosted web, GitHub, sandbox scheduling, and Discord delivery are operational.\n");

async function verifyGitHub() {
  const token = await resolveGitHubTaskToken(config);
  const { owner, repo } = parseGitHubRepository(config.github.repository);
  const response = await new Octokit({ auth: token }).repos.get({ owner, repo });
  if (response.data.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error("GitHub canary authenticated against an unexpected repository.");
  }
}

async function verifySandboxScheduling() {
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();
  const batch = kubeConfig.makeApiClient(k8s.BatchV1Api);
  const namespace = config.execution.kubernetes.namespace;
  const name = `post-deploy-canary-${randomUUID().slice(0, 8)}`;
  try {
    await batch.createNamespacedJob({
      namespace,
      body: {
        metadata: {
          name,
          labels: {
            "app.kubernetes.io/name": "discord-ai-agent",
            "app.kubernetes.io/component": "post-deploy-canary",
          },
        },
        spec: {
          activeDeadlineSeconds: 120,
          backoffLimit: 0,
          template: {
            metadata: { labels: { "app.kubernetes.io/component": "post-deploy-canary" } },
            spec: {
              restartPolicy: "Never",
              serviceAccountName: config.execution.kubernetes.serviceAccountName,
              containers: [{
                name: "canary",
                image: config.execution.kubernetes.sandboxImage,
                imagePullPolicy: config.execution.kubernetes.imagePullPolicy,
                command: ["node", "-e", "process.stdout.write('sandbox-canary-ok\\n')"],
              }],
            },
          },
        },
      },
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const job = await batch.readNamespacedJob({ namespace, name });
      if ((job.status?.succeeded ?? 0) > 0) return;
      if ((job.status?.failed ?? 0) > 0) throw new Error("Sandbox scheduling canary Job failed.");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("Sandbox scheduling canary Job did not complete within 120 seconds.");
  } finally {
    await batch.deleteNamespacedJob({ namespace, name, propagationPolicy: "Background" }).catch((error: unknown) => {
      if (kubernetesStatus(error) !== 404) throw error;
    });
  }
}

async function verifyDiscordDelivery(channelId: string) {
  const headers = { Authorization: `Bot ${config.discord.token}`, "Content-Type": "application/json" };
  const message = await discordRequest<{ id: string }>(`/channels/${channelId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: `Post-deploy canary passed for ${config.appRevision}. This message will be removed automatically.`,
      allowed_mentions: { parse: [] },
    }),
  });
  await discordRequest(`/channels/${channelId}/messages/${message.id}`, { method: "DELETE", headers });
}

async function discordRequest<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, init);
  if (!response.ok) throw new Error(`Discord canary request ${init.method ?? "GET"} ${path} failed (${response.status}).`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function kubernetesStatus(error: unknown) {
  if (typeof error !== "object" || error == null) return undefined;
  const candidate = error as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown } };
  return Number(candidate.code ?? candidate.statusCode ?? candidate.response?.statusCode);
}

function promptJson(stdout: string): { traceId: string; content: string } {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Post-deploy canary prompt returned no JSON result.");
  const value = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  if (typeof value.traceId !== "string" || typeof value.content !== "string") throw new Error("Post-deploy canary prompt result is incomplete.");
  return { traceId: value.traceId, content: value.content };
}
