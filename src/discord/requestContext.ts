import { Events, type Client, type Message, type PartialMessage } from "discord.js";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { BudgetRepository } from "../db/budgetRepository.js";
import type { RngRepository } from "../db/rngRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type { ConversationMessage, DiscordAiAgentRepository } from "../db/repositories.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { JobRuntime } from "../jobs/queue.js";
import type { AgentRuntimePromptExecutor } from "../agent/runtimeExecutor.js";
import type { AgentRuntimeTurnEnvelope } from "../agent/runtimeEnvelope.js";
import type { AgentPromptExecutionRef } from "../agent/runtimeLedger.js";
import type { DiscordResponseFooter } from "./responseSink.js";
import { durationMs, logger } from "../util/logger.js";
import type { TraceContext } from "../util/trace.js";
import type { WalletService } from "../payments/walletService.js";

export type DiscordAgentRequestInput = {
  config: AppConfig;
  repo: DiscordAiAgentRepository;
  budgetRepo?: BudgetRepository;
  rngRepo?: RngRepository;
  walletService?: WalletService;
  agentRuntime?: AgentRuntimeRepository;
  deliveryObligations?: DeliveryObligationsRepository;
  agentExecutor?: AgentRuntimePromptExecutor;
  openRouter: OpenRouterClient;
  jobs?: JobRuntime;
};

export type DiscordAgentExecutionRequest = {
  requestId: string;
  agentSessionId?: string;
  agentExecutionId?: string;
  inputLinesArtifactId?: string | null;
  text: string;
  rawContent: string;
  botRoleIds: string[];
  messageStartedAt: number;
  turnEnvelope?: AgentRuntimeTurnEnvelope | null;
  requestKind?: "message" | "component" | "modal";
  userId?: string;
  userDisplayName?: string;
  interaction?: AgentRuntimeTurnEnvelope["interaction"];
  requestAttachments?: AgentRuntimeTurnEnvelope["requestAttachments"];
};

export type PreparedDiscordAgentTurn = {
  turnEnvelope: AgentRuntimeTurnEnvelope;
  turnEnvelopeArtifactId: string | null;
  inputLinesArtifactId: string | null;
  priorSessionMessages: ConversationMessage[];
};

export function discordMessageTraceContext(
  message: Pick<Message | PartialMessage, "id" | "guildId" | "channelId"> & {
    author?: { id: string } | null;
  }
): TraceContext {
  return {
    traceId: message.id,
    requestId: message.id,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    userId: message.author?.id,
    messageId: message.id
  };
}

export async function recordTraceEvent(
  repo: DiscordAiAgentRepository,
  input: Parameters<DiscordAiAgentRepository["recordTraceEvent"]>[0]
) {
  const recorder = (repo as unknown as { recordTraceEvent?: (event: typeof input) => Promise<void> }).recordTraceEvent;
  if (!recorder) return;
  await recorder.call(repo, input).catch((error) => {
    logger.warn({ err: error, eventName: input.eventName }, "Failed to record trace event");
  });
}

export async function markDiscordDeliveryDelivered(
  input: DiscordAgentRequestInput,
  executionId: string,
  message: Message,
  requestLogger: Logger
) {
  await input.deliveryObligations?.markDelivered({
    executionId,
    statusChannelId: message.channelId,
    statusMessageId: message.id,
    metadata: { replyUrl: message.url }
  }).catch((error) => requestLogger.warn({ err: error, executionId }, "Failed to mark Discord delivery obligation delivered"));
}

export async function attachPromptTasksToDiscordReply(
  input: DiscordAgentRequestInput,
  traceId: string,
  finalReply: Message,
  requestLogger: Logger
) {
  const attachedTasks = await input.repo
    .attachAgentTasksToDiscordResponse({
      traceId,
      channelId: finalReply.channelId,
      messageId: finalReply.id
    })
    .catch((error) => {
      requestLogger.warn({ err: error, traceId, replyMessageId: finalReply.id }, "Failed to attach prompt agent tasks to Discord reply");
      return 0;
    });
  if (attachedTasks <= 0) return;
  requestLogger.info({ traceId, replyMessageId: finalReply.id, attachedTasks }, "Attached prompt agent tasks to Discord reply");
  await recordTraceEvent(input.repo, {
    eventName: "agent.tasks.attached_to_reply",
    summary: `Attached ${attachedTasks} agent task${attachedTasks === 1 ? "" : "s"} to the Discord reply`,
    metadata: {
      replyMessageId: finalReply.id,
      replyUrl: finalReply.url,
      attachedTasks
    }
  });
}

export async function recordAgentRuntimeSpan(input: {
  agentRuntime?: AgentRuntimeRepository;
  session: AgentPromptExecutionRef["session"];
  executionId: string;
  traceId: string;
  spanId: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";
  startedAt: Date;
  completedAt?: Date | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
}) {
  if (!input.agentRuntime) return;
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    traceId: input.traceId,
    kind: "status",
    level: input.status === "failed" ? "error" : "info",
    eventName: "agent.span",
    summary: input.name,
    durationMs: input.durationMs ?? null,
    metadata: {
      span: {
        spanId: input.spanId,
        name: input.name,
        status: input.status,
        startedAt: input.startedAt.toISOString(),
        completedAt: input.completedAt?.toISOString() ?? null,
        durationMs: input.durationMs ?? null,
        metadata: input.metadata ?? {}
      }
    }
  });
}

export async function storeAgentRuntimeResponseArtifact(input: {
  agentRuntime?: AgentRuntimeRepository;
  session: AgentPromptExecutionRef["session"];
  executionId: string;
  traceId: string;
  name: string;
  content: string;
  metadata?: Record<string, unknown>;
}) {
  if (!input.agentRuntime) return null;
  const artifact = await input.agentRuntime.storeArtifact({
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    kind: "response",
    name: input.name,
    content: input.content,
    contentType: "text/plain",
    metadata: { traceId: input.traceId, ...(input.metadata ?? {}) }
  });
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    traceId: input.traceId,
    kind: "artifact",
    eventName: "agent.execution.response_stored",
    summary: `Stored ${input.name}.`,
    metadata: { artifactId: artifact.artifactId, kind: artifact.kind }
  });
  return artifact;
}

export function discordTraceFooter(config: AppConfig, runId: string, startedAt: number): DiscordResponseFooter | null {
  const traceUrl = discordRunConsoleUrl(config, runId);
  if (!traceUrl) return null;
  return {
    traceUrl,
    durationMs: durationMs(startedAt)
  };
}

export function discordRunConsoleUrl(config: AppConfig, runId: string) {
  if (!config.controlUi.publicUrl) return null;
  return `${config.controlUi.publicUrl}/runs/${encodeURIComponent(runId)}`;
}

export async function waitForDiscordClientReady(client: Client, timeoutMs = 30_000) {
  if (client.isReady()) return;
  await Promise.race([
    new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve())),
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new TimeoutError(`Discord client was not ready after ${timeoutMs}ms.`)), timeoutMs);
      timeout.unref?.();
    })
  ]);
}

export async function fetchDiscordMessage(client: Client, channelId: string, messageId: string): Promise<Message> {
  const channel = await client.channels.fetch(channelId);
  const messages = (channel as any)?.messages;
  if (!messages?.fetch) throw new Error(`Discord channel ${channelId} cannot fetch messages.`);
  return (await messages.fetch(messageId)) as Message;
}

export function isTerminalProcessRunStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}

export function parseDateMs(value: string | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
