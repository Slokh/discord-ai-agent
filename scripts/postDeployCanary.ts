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
import { passingStatsCanaryChannel, passingWebCanaryChannel } from "../src/observability/postDeployCanaryEvidence.js";
import { deploymentToolset } from "../src/tools/toolScope.js";
import { extractPromptJson } from "./promptJson.js";

const execFileAsync = promisify(execFile);
const config = loadConfig();
assertDiscordConfig(config);
assertOpenRouterConfig(config);
assertExecutionConfig(config);

const deployed = deploymentToolset(config);
for (const name of ["getDiscordStats", "searchDiscordHistory", "runCodingAgent", "web__run"] as const) {
  if (!deployed.localTools.some((tool) => tool.name === name)) throw new Error(`Post-deploy canary is missing deployed capability ${name}.`);
}
for (const type of ["openrouter:web_search", "openrouter:web_fetch"] as const) {
  if (!deployed.serverTools.some((tool) => tool.type === type)) throw new Error(`Post-deploy canary is missing server capability ${type}.`);
}

await Promise.all([verifyGitHub(), verifySandboxScheduling()]);

const promptScript = fileURLToPath(new URL("./prompt.js", import.meta.url));
const utcDate = new Date().toISOString().slice(0, 10);
const privacyInstruction = "Do not quote, summarize, or identify any Discord message or member.";
const statsPrompt = [
  "This is an automated private post-deploy canary.",
  `Use getDiscordStats exactly once with {"dateFrom":"${utcDate}","dateTo":"${utcDate}","metric":"messages","groupBy":"overall","limit":1} to count today's indexed visible messages.`,
  "Do not call any other tool or retry this tool; report a failure immediately if it fails.",
  "Reply with POST_DEPLOY_STATS_OK and the numeric message count.",
  privacyInstruction,
].join(" ");
const webPrompt = [
  "This is an automated private post-deploy canary.",
  'Use web__run exactly once with {"time":[{"utc_offset":"+00:00"}],"response_length":"short"} to get the current UTC date.',
  "Do not call any other tool or retry this tool; report a failure immediately if it fails.",
  "Reply with POST_DEPLOY_WEB_OK and the UTC date.",
  privacyInstruction,
].join(" ");
const pool = createPool(config);
const deliveryChannelId = await runConversationCanary(pool).finally(async () => pool.end());

await verifyDiscordDelivery(deliveryChannelId);
process.stdout.write("Post-deploy canary passed: model, retrieval, hosted web, GitHub, sandbox scheduling, and Discord delivery are operational.\n");

async function runConversationCanary(database: ReturnType<typeof createPool>) {
  await runCapabilityCanary(database, statsPrompt, "POST_DEPLOY_STATS_OK", passingStatsCanaryChannel);
  return await runCapabilityCanary(database, webPrompt, "POST_DEPLOY_WEB_OK", passingWebCanaryChannel);
}

async function runCapabilityCanary(
  database: ReturnType<typeof createPool>,
  prompt: string,
  successMarker: string,
  passingChannel: (database: ReturnType<typeof createPool>, traceId: string) => Promise<string | undefined>,
) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        promptScript,
        "--no-memory",
        "--json",
        "--user-id", `post-deploy-canary-${randomUUID()}`,
        "--user-name", "Post-deploy canary",
        prompt,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, LOG_LEVEL: "warn" },
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const result = extractPromptJson(stdout);
      if (typeof result.traceId !== "string" || !result.content.includes(successMarker)) continue;
      const channelId = await passingChannel(database, result.traceId);
      if (channelId) return channelId;
    } catch {
      // Retry the isolated conversation once; tools remain non-retriable inside each attempt.
    }
  }
  throw new Error(`${successMarker} canary did not produce complete durable evidence after two isolated attempts.`);
}

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
