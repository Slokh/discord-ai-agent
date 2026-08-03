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
  productConfig,
} from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createAppDatabase } from "../src/db/repositories.js";
import { resolveGitHubTaskToken } from "../src/execution/githubAuth.js";
import { taskBearerToken } from "../src/execution/token.js";
import { parseGitHubRepository } from "../src/github/repository.js";
import { passingRandomCanaryChannel, passingStatsCanaryChannel, passingWebCanaryChannel } from "../src/observability/postDeployCanaryEvidence.js";
import { waitForSandboxCallback } from "../src/observability/sandboxCallbackCanary.js";
import { deploymentToolset } from "../src/tools/toolScope.js";
import { discordWrite } from "../src/discord/api.js";
import { logger } from "../src/util/logger.js";
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
  "Use web__run exactly once to get the current UTC date.",
  'Pass one object argument, not a JSON string: {time: [{utc_offset: "+00:00"}], response_length: "short"}.',
  "Do not call any other tool or retry this tool; report a failure immediately if it fails.",
  "Reply with POST_DEPLOY_WEB_OK and the UTC date.",
  privacyInstruction,
].join(" ");
const randomPrompt = [
  "This is an automated private post-deploy canary.",
  'Use drawRandom exactly once with {"kind":"dice","sides":6,"until":{"values":[1,2,3,4,5,6],"maxDraws":10},"reason":"post-deploy bounded draw"}.',
  "Do not call any other tool or retry this tool; report a failure immediately if it fails.",
  "Reply with POST_DEPLOY_RANDOM_OK and the verified result.",
  privacyInstruction,
].join(" ");
const pool = createPool(config);
let deliveryChannelId: string;
try {
  await Promise.all([verifyGitHub(), verifySandboxCallback(pool)]);
  deliveryChannelId = await runConversationCanary(pool);
} finally {
  await pool.end();
}

await verifyDiscordRetryBoundary();
await verifyDiscordAccess(deliveryChannelId);
process.stdout.write("Post-deploy canary passed: model, retrieval, bounded randomness, hosted web, follow-up continuity, GitHub, sandbox scheduling, and Discord access are operational.\n");

async function runConversationCanary(database: ReturnType<typeof createPool>) {
  await runCapabilityCanary(database, statsPrompt, "POST_DEPLOY_STATS_OK", passingStatsCanaryChannel);
  await runCapabilityCanary(database, randomPrompt, "POST_DEPLOY_RANDOM_OK", passingRandomCanaryChannel);
  const channelId = await runCapabilityCanary(database, webPrompt, "POST_DEPLOY_WEB_OK", passingWebCanaryChannel);
  await runFollowUpContinuityCanary(database, channelId);
  return channelId;
}

async function runFollowUpContinuityCanary(database: ReturnType<typeof createPool>, channelId: string) {
  const userId = `post-deploy-continuity-${randomUUID()}`;
  const phrase = `continuity-${randomUUID().slice(0, 8)}`;
  let threadKey: string | null = null;
  try {
    const first = await runPrompt([
      "This is an automated private post-deploy continuity canary.",
      `Remember the exact phrase ${phrase} for my next message in this conversation.`,
      "Reply only with POST_DEPLOY_CONTEXT_STORED.",
      privacyInstruction,
    ].join(" "), { userId, channelId, memory: true });
    if (!first.content.includes("POST_DEPLOY_CONTEXT_STORED")) throw new Error("Continuity setup turn did not acknowledge stored context.");
    threadKey = typeof first.threadKey === "string" ? first.threadKey : null;

    const second = await runPrompt([
      "What exact phrase did I ask you to remember in my previous message?",
      `Reply only with POST_DEPLOY_CONTINUITY_OK followed by that phrase.`,
      privacyInstruction,
    ].join(" "), { userId, channelId, memory: true });
    if (!second.content.includes("POST_DEPLOY_CONTINUITY_OK") || !second.content.includes(phrase)) {
      throw new Error("Follow-up turn did not recover the exact prior-turn context.");
    }
  } finally {
    if (threadKey) await database.query("DELETE FROM conversation_sessions WHERE thread_key = $1", [threadKey]);
  }
}

async function runCapabilityCanary(
  database: ReturnType<typeof createPool>,
  prompt: string,
  successMarker: string,
  passingChannel: (database: ReturnType<typeof createPool>, traceId: string) => Promise<string | undefined>,
) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await runPrompt(prompt, { userId: `post-deploy-canary-${randomUUID()}`, memory: false });
      if (typeof result.traceId !== "string" || !result.content.includes(successMarker)) continue;
      const channelId = await passingChannel(database, result.traceId);
      if (channelId) return channelId;
    } catch {
      // Retry the isolated conversation once; tools remain non-retriable inside each attempt.
    }
  }
  throw new Error(`${successMarker} canary did not produce complete durable evidence after two isolated attempts.`);
}

async function runPrompt(prompt: string, input: { userId: string; channelId?: string; memory: boolean }) {
  const args = [promptScript, "--json", "--user-id", input.userId, "--user-name", "Post-deploy canary"];
  if (!input.memory) args.push("--no-memory");
  if (input.channelId) args.push("--channel-id", input.channelId);
  args.push(prompt);
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, LOG_LEVEL: "warn" },
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return extractPromptJson(stdout);
}

async function verifyGitHub() {
  const token = await resolveGitHubTaskToken(config);
  const { owner, repo } = parseGitHubRepository(config.github.repository);
  const response = await new Octokit({ auth: token }).repos.get({ owner, repo });
  if (response.data.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error("GitHub canary authenticated against an unexpected repository.");
  }
}

async function verifySandboxCallback(database: ReturnType<typeof createPool>) {
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();
  const batch = kubeConfig.makeApiClient(k8s.BatchV1Api);
  const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const namespace = config.execution.kubernetes.namespace;
  const name = `post-deploy-canary-${randomUUID().slice(0, 8)}`;
  const secretName = `${name}-secret`;
  const taskId = `${name}-task`;
  const sandboxRunId = `${name}-run`;
  const repo = createAppDatabase(database);
  await repo.upsertAgentTaskQueued({
    taskId,
    taskType: "post-deploy-canary",
    title: "Verify sandbox callback boundary",
    request: "Complete a signed no-change callback without running repository code.",
    requestedBy: "deployment",
    backend: "kubernetes-sandbox",
  });
  await repo.markAgentTaskRunning({ taskId, backend: "kubernetes-sandbox", step: "callback_canary" });
  const token = taskBearerToken({ taskId, sandboxRunId, secret: config.execution.taskSigningSecret });
  const labels = {
    "app.kubernetes.io/name": "discord-ai-agent",
    "app.kubernetes.io/component": "sandbox",
    "discord-ai-agent/task-id": taskId,
    "discord-ai-agent/sandbox-run-id": sandboxRunId,
  };
  try {
    await core.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name: secretName, labels },
        type: "Opaque",
        stringData: {
          CANARY_TASK_ID: taskId,
          CANARY_SANDBOX_RUN_ID: sandboxRunId,
          CANARY_TASK_TOKEN: token,
          CANARY_SIGNING_SECRET: config.execution.taskSigningSecret,
          CANARY_CALLBACK_URL: productConfig.control.internalUrl,
        },
      },
    });
    await batch.createNamespacedJob({
      namespace,
      body: {
        metadata: {
          name,
          labels,
        },
        spec: {
          activeDeadlineSeconds: 120,
          backoffLimit: 0,
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: "Never",
              serviceAccountName: config.execution.kubernetes.serviceAccountName,
              containers: [{
                name: "canary",
                image: config.execution.kubernetes.sandboxImage,
                imagePullPolicy: config.execution.kubernetes.imagePullPolicy,
                envFrom: [{ secretRef: { name: secretName } }],
                command: ["node", "-e", sandboxCallbackScript()],
              }],
            },
          },
        },
      },
    });
    await waitForSandboxCallback({
      readTaskStatus: async () => (await repo.getAgentTask(taskId))?.status,
      readJobStatus: async () => {
        try {
          return (await batch.readNamespacedJob({ namespace, name })).status;
        } catch (error) {
          if (kubernetesStatus(error) === 404) return undefined;
          throw error;
        }
      },
    });
  } finally {
    await batch.deleteNamespacedJob({ namespace, name, propagationPolicy: "Background" }).catch((error: unknown) => {
      if (kubernetesStatus(error) !== 404) throw error;
    });
    await core.deleteNamespacedSecret({ namespace, name: secretName }).catch((error: unknown) => {
      if (kubernetesStatus(error) !== 404) throw error;
    });
    await database.query("DELETE FROM process_runs WHERE run_id = $1", [taskId]);
    await database.query("DELETE FROM agent_tasks WHERE task_id = $1", [taskId]);
  }
}

function sandboxCallbackScript() {
  return `
    const { createHmac } = require("node:crypto");
    const taskId = process.env.CANARY_TASK_ID;
    const sandboxRunId = process.env.CANARY_SANDBOX_RUN_ID;
    const secret = process.env.CANARY_SIGNING_SECRET;
    const body = JSON.stringify({
      status: "no_changes",
      verifyPassed: true,
      error: "Post-deploy callback canary completed without repository work.",
      metadata: { sandboxRunId, canary: true }
    });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret).update(timestamp + ".").update(body).digest("hex");
    fetch(process.env.CANARY_CALLBACK_URL + "/internal/tasks/" + encodeURIComponent(taskId) + "/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + process.env.CANARY_TASK_TOKEN,
        "x-agent-task-timestamp": timestamp,
        "x-agent-task-signature": signature
      },
      body
    }).then(async (response) => {
      if (!response.ok) throw new Error("callback failed (" + response.status + "): " + await response.text());
      process.stdout.write("sandbox-callback-canary-ok\\n");
    }).catch((error) => { console.error(error); process.exit(1); });
  `;
}

async function verifyDiscordAccess(channelId: string) {
  const headers = { Authorization: `Bot ${config.discord.token}` };
  const [bot, channel] = await Promise.all([
    discordRequest<{ id: string; bot?: boolean }>("/users/@me", { headers }),
    discordRequest<{ id: string; guild_id?: string }>(`/channels/${channelId}`, { headers }),
  ]);
  if (bot.id !== config.discord.clientId || bot.bot !== true) {
    throw new Error("Discord canary authenticated as an unexpected bot identity.");
  }
  if (channel.id !== channelId || channel.guild_id !== config.discord.guildId) {
    throw new Error("Discord canary resolved an unexpected channel or guild.");
  }
}

async function verifyDiscordRetryBoundary() {
  let attempts = 0;
  const result = await discordWrite(async () => {
    attempts += 1;
    if (attempts === 1) throw { status: 429, retry_after: 0 };
    return "retried";
  }, { logger, retries: 1, sleep: async () => undefined }, "post_deploy_retry_canary");
  if (!result.ok || result.value !== "retried" || attempts !== 2) {
    throw new Error("Discord write retry boundary did not recover one retryable failure.");
  }
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
