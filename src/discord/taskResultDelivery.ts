import type { Client } from "discord.js";
import type { Logger } from "pino";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { AgentTaskRecord, DiscordAiAgentRepository } from "../db/repositories.js";
import { taskTypesDeliveringResults } from "../execution/sandboxProfiles.js";
import { formatAgentTaskResult } from "../tools/agentTaskFormatting.js";
import {
  DISCORD_DELIVERY_INTENT_ARTIFACT_KIND,
  createDiscordDeliveryIntent,
  discordDeliveryFileReferenceSchema,
  serializeDiscordDeliveryIntent,
  type DiscordDeliveryFileReference,
} from "./deliveryIntent.js";
import { sweepDiscordDeliveryObligations } from "./deliverySweep.js";

/**
 * Sandbox task results reach Discord through the same durable delivery
 * obligations as chat replies. The bot turns each finished task into one
 * delivery intent (formatted result plus files the sandbox agent chose to
 * deliver) and an obligation of this kind; the shared sweep renders it.
 */
export const AGENT_TASK_RESULT_DELIVERY_KIND = "agent_task_result";
export const RESULT_FILE_ARTIFACT_KIND = "result_file";

const RESULT_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 10_000;
const SNOWFLAKE = /^\d{17,20}$/;

export function agentTaskExecutionId(taskId: string) {
  return `agent-task-execution-${taskId}`;
}

type DeliveryRepos = {
  repo: Pick<
    DiscordAiAgentRepository,
    | "listAgentTasksAwaitingResultDelivery"
    | "getAgentRuntimeTaskEventsForTask"
    | "getSandboxCommandEvents"
    | "markAgentTaskRendered"
    | "markAgentTaskNotificationFailed"
  >;
  agentRuntime: Pick<AgentRuntimeRepository, "getExecution" | "listArtifactsForExecution" | "storeArtifact">;
  obligations: Pick<DeliveryObligationsRepository, "upsertPending">;
  logger: Pick<Logger, "info" | "warn">;
};

/** Hands every newly finished, requester-facing task to durable delivery exactly once. */
export async function enqueueAgentTaskResultDeliveries(input: DeliveryRepos & { limit?: number }) {
  const tasks = await input.repo.listAgentTasksAwaitingResultDelivery({
    taskTypes: taskTypesDeliveringResults(),
    completedWithinMs: RESULT_DELIVERY_WINDOW_MS,
    limit: input.limit ?? 10,
  });
  let enqueued = 0;
  for (const task of tasks) {
    try {
      if (await enqueueAgentTaskResultDelivery(input, task)) enqueued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.logger.warn({ err: error, taskId: task.taskId }, "Failed to enqueue agent task result delivery");
      await input.repo.markAgentTaskNotificationFailed({ taskId: task.taskId, error: message }).catch(() => undefined);
    }
  }
  return enqueued;
}

export function agentTaskResultTarget(task: Pick<AgentTaskRecord, "traceId" | "channelId" | "discordResponseChannelId" | "discordResponseMessageId">) {
  // Chat-started tasks carry the requester's Discord message ID as their trace;
  // other starts (such as reaction retries) reply under their status message.
  if (task.traceId && SNOWFLAKE.test(task.traceId) && task.channelId) {
    return { channelId: task.channelId, sourceMessageId: task.traceId };
  }
  if (task.discordResponseChannelId && task.discordResponseMessageId) {
    return { channelId: task.discordResponseChannelId, sourceMessageId: task.discordResponseMessageId };
  }
  return null;
}

async function enqueueAgentTaskResultDelivery(input: DeliveryRepos, task: AgentTaskRecord) {
  const target = agentTaskResultTarget(task);
  if (!target || !task.guildId || !task.userId) {
    await input.repo.markAgentTaskNotificationFailed({ taskId: task.taskId, error: "Task has no Discord requester or reply target." });
    return false;
  }
  const executionId = agentTaskExecutionId(task.taskId);
  const execution = await input.agentRuntime.getExecution({ executionId });
  if (!execution) throw new Error(`Agent task execution ${executionId} is missing.`);

  const [taskEvents, commandEvents, fileArtifacts] = await Promise.all([
    input.repo.getAgentRuntimeTaskEventsForTask({ taskId: task.taskId, limit: 30 }),
    input.repo.getSandboxCommandEvents({ guildId: task.guildId, visibleChannelIds: task.channelId ? [task.channelId] : undefined, taskId: task.taskId, limit: 8 }),
    task.status === "succeeded"
      ? input.agentRuntime.listArtifactsForExecution({ executionId, kind: RESULT_FILE_ARTIFACT_KIND })
      : Promise.resolve([]),
  ]);
  const content = formatAgentTaskResult({ taskId: task.taskId, jobId: task.pgBossJobId, job: task, taskEvents, commandEvents });
  const intent = createDiscordDeliveryIntent({
    deliveryKey: `agent-task-result:${task.taskId}`,
    requesterUserId: task.userId,
    content,
    files: resultFileReferences(fileArtifacts),
  });
  const intentArtifact = await input.agentRuntime.storeArtifact({
    sessionId: execution.sessionId,
    executionId,
    kind: DISCORD_DELIVERY_INTENT_ARTIFACT_KIND,
    name: "Agent task result delivery intent",
    content: serializeDiscordDeliveryIntent(intent),
    contentType: "application/json",
    eventName: "discord.delivery.intent_stored",
  });
  await input.obligations.upsertPending({
    executionId,
    threadKey: task.threadKey,
    guildId: task.guildId,
    channelId: target.channelId,
    sourceMessageId: target.sourceMessageId,
    metadata: { kind: AGENT_TASK_RESULT_DELIVERY_KIND, taskId: task.taskId, deliveryIntentArtifactId: intentArtifact.artifactId },
  });
  await input.repo.markAgentTaskRendered({ taskId: task.taskId, signature: `durable:${intentArtifact.artifactId}`, terminal: true });
  input.logger.info({ taskId: task.taskId, status: task.status, files: intent.files.length }, "Enqueued agent task result delivery");
  return true;
}

export function resultFileReferences(
  artifacts: Array<{ artifactId: string; name: string; contentType: string; sizeBytes: number; metadata: Record<string, unknown> }>,
): DiscordDeliveryFileReference[] {
  const usedNames = new Set<string>();
  return [...artifacts]
    .filter((artifact) => artifact.metadata.deliver === true && typeof artifact.metadata.sha256 === "string")
    .sort((left, right) => Number(left.metadata.order ?? 0) - Number(right.metadata.order ?? 0))
    .slice(0, 4)
    .map((artifact) => discordDeliveryFileReferenceSchema.parse({
      artifactId: artifact.artifactId,
      name: uniqueAttachmentName(artifact.name, usedNames),
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.metadata.sha256,
    }));
}

function uniqueAttachmentName(name: string, used: Set<string>) {
  const cleaned = name.replace(/[^\w.-]+/g, "_").slice(0, 120) || "result";
  let candidate = cleaned;
  for (let index = 1; used.has(candidate.toLowerCase()); index += 1) {
    const dot = cleaned.lastIndexOf(".");
    candidate = dot > 0 ? `${cleaned.slice(0, dot)}-${index}${cleaned.slice(dot)}` : `${cleaned}-${index}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Bot-owned loop: enqueue finished task results, then deliver pending task-result obligations. */
export function startAgentTaskResultDelivery(input: {
  client: Client;
  repo: DiscordAiAgentRepository;
  agentRuntime: AgentRuntimeRepository;
  obligations: DeliveryObligationsRepository;
  logger: Logger;
  maxReplyChars: number;
  premiumSkuIds?: string[];
  run: (label: string, task: () => Promise<void>) => void;
  intervalMs?: number;
}) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    input.run("agent_task_result_delivery", async () => {
      try {
        await enqueueAgentTaskResultDeliveries({ repo: input.repo, agentRuntime: input.agentRuntime, obligations: input.obligations, logger: input.logger });
        await sweepDiscordDeliveryObligations({
          client: input.client,
          obligations: input.obligations,
          agentRuntime: input.agentRuntime,
          repo: input.repo,
          logger: input.logger,
          maxReplyChars: input.maxReplyChars,
          premiumSkuIds: input.premiumSkuIds,
          kind: AGENT_TASK_RESULT_DELIVERY_KIND,
          olderThanMs: 0,
        });
      } finally {
        running = false;
      }
    });
  };
  const timer = setInterval(tick, input.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
